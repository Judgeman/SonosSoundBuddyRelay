// Tests für den Abgleich zwischen Tablets: node --test
// KV-Speicher und Sonos werden nachgebaut, es geht nichts ins Netz.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const BASE = "https://relay.example";
// Token → Haushalte, wie Sonos sie liefern würde
const TOKENS = {
  "token-a": ["Sonos_A"],
  "token-b": ["Sonos_B"],
  "token-ab": ["Sonos_A", "Sonos_B"],
};

class MemoryKV {
  constructor() {
    this.data = new Map();
  }
  async get(key, type) {
    if (!this.data.has(key)) return null;
    const value = this.data.get(key);
    if (type === "json") return JSON.parse(value);
    if (type === "text") return value;
    if (type === "arrayBuffer") return value;
    if (type === "stream") return new Blob([value]).stream();
    return value;
  }
  async put(key, value) {
    this.data.set(key, value);
  }
  async delete(key) {
    this.data.delete(key);
  }
}

let env;

beforeEach(() => {
  env = { SYNC_KV: new MemoryKV() };
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.ws.sonos.com/control/api/v1/households");
    const token = (init?.headers?.Authorization ?? "").replace("Bearer ", "");
    const households = TOKENS[token];
    if (!households) return new Response("{}", { status: 401 });
    return Response.json({ households: households.map((id) => ({ id })) });
  };
});

function call(method, path, { token = "token-a", household = "Sonos_A", body } = {}) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}household=${encodeURIComponent(household)}`;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return worker.fetch(new Request(url, { method, headers, body }), env);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function upload(snapshot, images, options = {}) {
  const hashes = [];
  for (const bytes of images) {
    const hash = await sha256Hex(bytes);
    hashes.push(hash);
    const response = await call("PUT", `/sync/images/${hash}`, { ...options, body: bytes });
    assert.equal(response.status, 200);
  }
  const body = JSON.stringify({ deviceName: "Wohnzimmer-Tablet", images: hashes, snapshot });
  return { hashes, response: await call("PUT", "/sync/snapshot", { ...options, body }) };
}

test("ohne KV-Binding meldet der Worker, dass der Abgleich nicht eingerichtet ist", async () => {
  env = {};
  const response = await call("GET", "/sync/state");
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error, "sync_not_configured");
});

test("ohne oder mit ungültigem Token gibt es 401", async () => {
  assert.equal((await call("GET", "/sync/state", { token: null })).status, 401);
  assert.equal((await call("GET", "/sync/state", { token: "falsch" })).status, 401);
});

test("fremder Haushalt wird abgelehnt", async () => {
  const response = await call("GET", "/sync/state", { token: "token-a", household: "Sonos_B" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "forbidden_household");
});

test("ungültiger Haushalt-Parameter gibt 400", async () => {
  assert.equal((await call("GET", "/sync/state", { household: "../x" })).status, 400);
});

test("hochladen und abholen", async () => {
  assert.equal((await call("GET", "/sync/state")).status, 404);

  const image = new TextEncoder().encode("bild-1");
  const { hashes, response } = await upload({ profiles: [{ name: "Mia" }] }, [image]);
  assert.equal(response.status, 200);
  const put = await response.json();
  assert.ok(put.version);

  const state = await (await call("GET", "/sync/state")).json();
  assert.equal(state.version, put.version);
  assert.equal(state.deviceName, "Wohnzimmer-Tablet");

  const stored = await (await call("GET", "/sync/snapshot")).json();
  assert.equal(stored.version, put.version);
  assert.deepEqual(stored.snapshot, { profiles: [{ name: "Mia" }] });

  const imageResponse = await call("GET", `/sync/images/${hashes[0]}`);
  assert.equal(imageResponse.status, 200);
  assert.equal(new TextDecoder().decode(await imageResponse.arrayBuffer()), "bild-1");
});

test("Haushalte bleiben getrennt", async () => {
  await upload({ profiles: [{ name: "A" }] }, [], { token: "token-a", household: "Sonos_A" });
  await upload({ profiles: [{ name: "B" }] }, [], { token: "token-b", household: "Sonos_B" });

  const a = await (await call("GET", "/sync/snapshot", { token: "token-ab", household: "Sonos_A" })).json();
  const b = await (await call("GET", "/sync/snapshot", { token: "token-ab", household: "Sonos_B" })).json();
  assert.equal(a.snapshot.profiles[0].name, "A");
  assert.equal(b.snapshot.profiles[0].name, "B");
  // Bilder sind ebenfalls je Haushalt abgelegt
  const image = new TextEncoder().encode("nur-a");
  const { hashes } = await upload({}, [image], { token: "token-a", household: "Sonos_A" });
  assert.equal((await call("GET", `/sync/images/${hashes[0]}`, { token: "token-b", household: "Sonos_B" })).status, 404);
});

test("Bild mit falschem Namen wird abgelehnt", async () => {
  const response = await call("PUT", `/sync/images/${"0".repeat(64)}`, { body: new TextEncoder().encode("x") });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "hash_mismatch");
});

test("Stand mit fehlendem Bild wird abgelehnt, missing listet es", async () => {
  const hash = await sha256Hex(new TextEncoder().encode("fehlt"));
  const body = JSON.stringify({ deviceName: "x", images: [hash], snapshot: {} });
  const response = await call("PUT", "/sync/snapshot", { body });
  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).missing, [hash]);

  const missing = await call("POST", "/sync/images/missing", { body: JSON.stringify({ hashes: [hash] }) });
  assert.deepEqual((await missing.json()).missing, [hash]);
});

test("nicht mehr gebrauchte Bilder werden gelöscht, Löschen räumt alles weg", async () => {
  const one = new TextEncoder().encode("eins");
  const two = new TextEncoder().encode("zwei");
  const first = await upload({}, [one, two]);
  const second = await upload({}, [two]);
  assert.equal((await call("GET", `/sync/images/${first.hashes[0]}`)).status, 404);
  assert.equal((await call("GET", `/sync/images/${second.hashes[0]}`)).status, 200);

  assert.equal((await call("DELETE", "/sync")).status, 200);
  assert.equal(env.SYNC_KV.data.size, 0);
});

test("Login-Endpunkte bleiben erreichbar", async () => {
  const response = await worker.fetch(new Request(`${BASE}/`), env);
  assert.equal(response.status, 200);
});
