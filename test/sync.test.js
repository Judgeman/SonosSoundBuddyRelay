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
  // Wie Cloudflare seitenweise — hier absichtlich kleine Seiten, damit das Weiterblättern getestet ist
  async list({ prefix = "", cursor } = {}) {
    const names = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const end = start + 2;
    return {
      keys: names.slice(start, end).map((name) => ({ name })),
      list_complete: end >= names.length,
      cursor: end >= names.length ? undefined : String(end),
    };
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

  // Auch was die Tablets schon gespielt haben
  await putPlayed("tablet-1", ["FAVORITE:1:Bibi"]);
  await putPlayed("tablet-2", ["PLAYLIST:2:Tanzen"]);
  await putPlayed("tablet-3", ["FAVORITE:3:Radio"]);

  assert.equal((await call("DELETE", "/sync")).status, 200);
  assert.equal(env.SYNC_KV.data.size, 0);
});

function putPlayed(tablet, keys, options = {}) {
  return call("PUT", `/sync/played/${tablet}`, { ...options, body: JSON.stringify({ keys }) });
}

async function getPlayed(options = {}) {
  const response = await call("GET", "/sync/played", options);
  assert.equal(response.status, 200);
  return (await response.json()).played;
}

test("gespielte Musik: jedes Tablet hat seine Liste, abgeholt wird alles zusammen", async () => {
  assert.deepEqual(await getPlayed(), []);

  assert.equal((await putPlayed("tablet-1", ["FAVORITE:1:Bibi", "PLAYLIST:2:Tanzen"])).status, 200);
  assert.equal((await putPlayed("tablet-2", ["PLAYLIST:2:Tanzen", "FAVORITE:3:Radio"])).status, 200);
  // Mehr Tablets als eine Seite der Liste
  assert.equal((await putPlayed("tablet-3", ["FAVORITE:4:Schlaflied"])).status, 200);
  assert.deepEqual(await getPlayed(), ["FAVORITE:1:Bibi", "FAVORITE:3:Radio", "FAVORITE:4:Schlaflied", "PLAYLIST:2:Tanzen"]);

  // Ein Tablet ersetzt nur seine eigene Liste
  await putPlayed("tablet-1", ["FAVORITE:1:Bibi"]);
  assert.deepEqual(await getPlayed(), ["FAVORITE:1:Bibi", "FAVORITE:3:Radio", "FAVORITE:4:Schlaflied", "PLAYLIST:2:Tanzen"]);
  await putPlayed("tablet-2", []);
  assert.deepEqual(await getPlayed(), ["FAVORITE:1:Bibi", "FAVORITE:4:Schlaflied"]);
});

test("gespielte Musik bleibt je Haushalt getrennt", async () => {
  await putPlayed("tablet-1", ["FAVORITE:1:A"], { token: "token-a", household: "Sonos_A" });
  await putPlayed("tablet-1", ["FAVORITE:1:B"], { token: "token-b", household: "Sonos_B" });
  assert.deepEqual(await getPlayed({ token: "token-ab", household: "Sonos_A" }), ["FAVORITE:1:A"]);
  assert.deepEqual(await getPlayed({ token: "token-ab", household: "Sonos_B" }), ["FAVORITE:1:B"]);
  assert.equal((await putPlayed("tablet-1", ["x"], { token: "token-a", household: "Sonos_B" })).status, 403);

  // Löschen betrifft nur den eigenen Haushalt
  await call("DELETE", "/sync", { token: "token-a", household: "Sonos_A" });
  assert.deepEqual(await getPlayed({ token: "token-ab", household: "Sonos_A" }), []);
  assert.deepEqual(await getPlayed({ token: "token-ab", household: "Sonos_B" }), ["FAVORITE:1:B"]);
});

test("ungültige Liste gespielter Musik wird abgelehnt", async () => {
  assert.equal((await putPlayed("tablet:1", ["x"])).status, 400);
  assert.equal((await putPlayed("t".repeat(65), ["x"])).status, 400);
  assert.equal((await putPlayed("tablet-1", [""])).status, 400);
  assert.equal((await putPlayed("tablet-1", [42])).status, 400);
  assert.equal((await putPlayed("tablet-1", ["x".repeat(1001)])).status, 400);
  assert.equal((await call("PUT", "/sync/played/tablet-1", { body: JSON.stringify({}) })).status, 400);
  assert.equal((await call("PUT", "/sync/played/tablet-1", { body: "kein json" })).status, 400);
  assert.deepEqual(await getPlayed(), []);
});

test("Login-Endpunkte bleiben erreichbar", async () => {
  const response = await worker.fetch(new Request(`${BASE}/`), env);
  assert.equal(response.status, 200);
});
