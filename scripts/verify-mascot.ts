// Pure checks for the launcher mascot's pose timeline and 3D projection
// (src/embed/Mascot.tsx). No browser: run with `npm run verify:mascot`.
import assert from "node:assert/strict";
import { geometry, poseAt, helloAt, REST, GREETING_SECONDS, HELLO_SECONDS, type Geo } from "../src/embed/Mascot";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const num = (s: string) => Number(s);
const tx = (m: string) => Number(m.match(/matrix\(([^)]+)\)/)![1].split(" ")[4]);
const strings = (g: Geo) => [g.roll, g.markM, g.markO, g.visor, g.vis, g.gloss, g.glo, ...["L", "R"].flatMap((s) => Object.values(g[s as "L" | "R"]))];

check("rest pose faces the visitor: eyes shown, happy eyes and back mark hidden", () => {
  const g = geometry(REST);
  for (const e of [g.L, g.R]) {
    assert.equal(num(e.o), 1);
    assert.equal(num(e.po), 0);
  }
  assert.equal(num(g.vis), 1);
  assert.equal(num(g.markO), 0);
});

check("rest pose is symmetric", () => {
  const g = geometry(REST);
  assert.ok(Math.abs(tx(g.L.m) + tx(g.R.m)) < 1e-3, `${tx(g.L.m)} vs ${tx(g.R.m)}`);
});

check("greeting starts with the back of the head (face hidden, Majestic mark shown)", () => {
  const g = geometry(poseAt(0));
  assert.equal(num(g.L.o), 0);
  assert.equal(num(g.R.o), 0);
  assert.equal(num(g.vis), 0);
  assert.ok(num(g.markO) > 0.4);
});

check("greeting ends exactly at the rest pose", () => {
  const p = poseAt(GREETING_SECONDS);
  for (const k of Object.keys(REST) as (keyof typeof REST)[]) assert.ok(Math.abs(p[k] - REST[k]) < 1e-9, `${k}=${p[k]}`);
  assert.deepEqual(poseAt(GREETING_SECONDS + 10), p);
});

check("every frame of the greeting is finite and stays inside the orb", () => {
  for (let t = 0; t <= GREETING_SECONDS + 1e-9; t += 0.02) {
    const g = geometry(poseAt(t));
    for (const s of strings(g)) assert.ok(!/NaN|Infinity/.test(s), `t=${t}: ${s}`);
    for (const pt of g.visor.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
      assert.ok(Math.hypot(Number(pt[1]), Number(pt[2])) <= 1.0015, `t=${t}: visor point outside the sphere`);
    }
  }
});

check("the face turns 180° in: hidden at the start, in front by the end of the spin", () => {
  const visibleAt = (t: number) => num(geometry(poseAt(t)).L.o) + num(geometry(poseAt(t)).R.o);
  assert.equal(visibleAt(0.1), 0);
  assert.ok(visibleAt(1.5) > 1.9);
});

check("header hello starts and ends facing the visitor, smiles in between", () => {
  for (const t of [0, HELLO_SECONDS, HELLO_SECONDS + 5]) {
    const p = helloAt(t);
    for (const k of Object.keys(REST) as (keyof typeof REST)[]) assert.ok(Math.abs(p[k] - REST[k]) < 1e-9, `t=${t} ${k}=${p[k]}`);
  }
  assert.equal(helloAt(1).happy, 1);
});

console.log(`\n${passed} checks passed`);
