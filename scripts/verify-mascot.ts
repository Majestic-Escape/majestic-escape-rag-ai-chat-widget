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

// Shoelace area of an SVG path made of M/L points, in the orb's -1..1 box (the orb itself is π).
const area = (d: string) => {
  const p = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i]!, [x2, y2] = p[(i + 1) % p.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
};

// The bug seen on a phone: early in the spin, while the visor wrapped past the back of
// the head, it was drawn over ~97% of the orb (a dark disc) for ~0.1 s.
check("visor and gloss are never drawn bigger than when facing you, and never jump (every 5 ms)", () => {
  const rest = geometry(REST);
  const restVisor = area(rest.visor), restGloss = area(rest.gloss);
  for (const [name, seconds, pose] of [["greeting", GREETING_SECONDS, poseAt], ["hello", HELLO_SECONDS, helloAt]] as const) {
    let prev: number | null = null;
    for (let t = 0; t <= seconds + 1e-9; t += 0.005) {
      const g = geometry(pose(t));
      const v = area(g.visor) * num(g.vis), gl = area(g.gloss) * num(g.glo) / 0.16;
      assert.ok(v <= restVisor * 1.05, `${name} t=${t.toFixed(3)}: visor area ${v.toFixed(3)} > ${restVisor.toFixed(3)}`);
      // The gloss sits off-centre, so it legitimately looks a little bigger when the head turns towards it.
      assert.ok(gl <= restGloss * 1.35, `${name} t=${t.toFixed(3)}: gloss area ${gl.toFixed(3)} > ${restGloss.toFixed(3)}`);
      if (prev !== null) assert.ok(Math.abs(v - prev) < 0.12, `${name} t=${t.toFixed(3)}: visor jumped ${prev.toFixed(3)} -> ${v.toFixed(3)}`);
      prev = v;
      for (const pt of g.visor.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
        assert.ok(Math.hypot(Number(pt[1]), Number(pt[2])) <= 1.0015, `${name} t=${t}: visor point outside the orb`);
      }
    }
  }
});

check("visor follows the head turn: hidden at the back, growing smoothly to full as it comes round", () => {
  const v = (t: number) => area(geometry(poseAt(t)).visor) * num(geometry(poseAt(t)).vis);
  assert.equal(v(0), 0);
  assert.ok(v(0.1) < 0.1, `t=0.1: ${v(0.1)}`);
  assert.ok(v(0.3) > 0.5 && v(0.3) < 1, `t=0.3: ${v(0.3)}`);
  assert.ok(Math.abs(v(1.5) - area(geometry(REST).visor)) < 0.02);
});

console.log(`\n${passed} checks passed`);
