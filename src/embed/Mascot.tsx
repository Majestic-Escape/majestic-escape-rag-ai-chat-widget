import React, { memo, useEffect, useRef, useState } from "react";

/**
 * The launcher mascot: a glossy orb whose visor and eyes are projected onto
 * the sphere, so turning the head curves and hides them the way a real ball
 * would. No images, no animation library: one SVG whose attributes are set
 * from a few lines of math.
 *
 * Motion budget: the greeting (spin in 180°, look around, nod) plays ONCE per
 * page load, then the only work is one slow blink every 5–7 s. Nothing runs
 * while the launcher is hidden or the tab is in the background, and nothing
 * moves at all under prefers-reduced-motion.
 */

type Ease = "out";
type Key = [number, number] | [number, number, Ease];

// Greeting timeline in seconds. yaw/pitch/roll in degrees; lead = how far the
// eyes run ahead of the head; blink 1 = open; happy 1 = peak eyes; tw = twinkle.
const KEYS: Record<keyof Pose, Key[]> = {
  yaw: [[0, 180], [1.15, -9, "out"], [1.5, 0], [1.9, 0], [2.5, -48], [3.0, -48], [3.95, 48], [4.35, 48], [4.9, 0]],
  pitch: [[0, 10], [1.15, -3, "out"], [1.5, 0], [1.9, 0], [2.5, 4], [3.0, 4], [3.45, -3], [3.95, 4], [4.35, 4], [4.9, 0], [5.05, 0], [5.32, -15], [5.6, 3], [5.85, 0]],
  roll: [[0, -8], [1.5, 0], [1.9, 0], [2.5, -3], [3.0, -3], [3.95, 3], [4.35, 3], [4.9, 0], [5.05, 0], [5.32, -7], [6.3, -7], [6.7, 0]],
  lead: [[1.9, 0], [2.02, -11], [2.5, 0], [3.0, 0], [3.12, 13], [3.95, 0], [4.35, 0], [4.45, -9], [4.9, 0]],
  blink: [[0, 1], [1.62, 1], [1.7, 0.08], [1.84, 1], [3.36, 1], [3.44, 0.08], [3.58, 1]],
  happy: [[0, 0], [5.05, 0], [5.25, 1], [6.3, 1], [6.55, 0]],
  tw: [[0, 0], [4.8, 0], [4.95, 1], [5.1, 0]],
};
export const GREETING_SECONDS = 6.7;
// Slow idle blink: close 0.18 s, hold, open 0.22 s.
const BLINK_KEYS: Key[] = [[0, 1], [0.18, 0.08], [0.23, 0.08], [0.45, 1]];
// "Hello" (the panel header, on every open): a twinkle, then a nod with the peak eyes.
const HELLO_KEYS: Partial<Record<keyof Pose, Key[]>> = {
  tw: [[0, 0], [0.15, 1], [0.3, 0]],
  pitch: [[0, 0], [0.3, 0], [0.57, -15], [0.85, 3], [1.1, 0]],
  roll: [[0, 0], [0.3, 0], [0.57, -7], [1.55, -7], [1.95, 0]],
  happy: [[0, 0], [0.3, 0], [0.5, 1], [1.55, 1], [1.8, 0]],
};
export const HELLO_SECONDS = 1.95;
export function helloAt(t: number): Pose {
  const p = { ...REST };
  (Object.keys(HELLO_KEYS) as (keyof Pose)[]).forEach((k) => (p[k] = track(HELLO_KEYS[k]!, t)));
  return p;
}

export type Pose = { yaw: number; pitch: number; roll: number; lead: number; blink: number; happy: number; tw: number };
export const REST: Pose = { yaw: 0, pitch: 0, roll: 0, lead: 0, blink: 1, happy: 0, tw: 0 };

const ease = (u: number, k?: Ease) =>
  k === "out" ? 1 - Math.pow(1 - u, 3) : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;

function track(keys: Key[], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t <= b[0]) {
      const a = keys[i - 1];
      return a[1] + (b[1] - a[1]) * ease((t - a[0]) / (b[0] - a[0]), b[2]);
    }
  }
  return keys[keys.length - 1][1];
}

export function poseAt(t: number): Pose {
  const p = { ...REST };
  (Object.keys(KEYS) as (keyof Pose)[]).forEach((k) => (p[k] = track(KEYS[k], t)));
  return p;
}

export type EyeGeo = { m: string; t: string; o: string; go: string; po: string };
export type Geo = { roll: string; markM: string; markO: string; visor: string; vis: string; gloss: string; glo: string; L: EyeGeo; R: EyeGeo };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const f3 = (v: number) => v.toFixed(3);
const D2R = Math.PI / 180;
// The head looks very slightly down at rest, so the visor's lower edge curves
// like a smile instead of sitting dead flat.
const BASE_PITCH = -6;

/** Orthographic projection of the visor, eyes and back mark for one pose, in a -1..1 box. */
export function geometry(p: Pose): Geo {
  const pit = (p.pitch + BASE_PITCH) * D2R, cp = Math.cos(pit), sp = Math.sin(pit);
  const proj = (lat: number, lon: number): [number, number, number] => {
    const la = lat * D2R, lo = (lon + p.yaw) * D2R, c = Math.cos(la);
    const x = c * Math.sin(lo), y = Math.sin(la), z = c * Math.cos(lo);
    return [x, -(y * cp + z * sp), -y * sp + z * cp];
  };
  // A rounded patch of the sphere (superellipse in lat/lon). Points that have
  // rotated behind the sphere are pinned to its edge, so the patch wraps.
  const region = (lonC: number, lonH: number, latC: number, latH: number, n: number, N: number) => {
    let d = "", maxZ = -1;
    for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N, c = Math.cos(a), s = Math.sin(a);
      const lon = lonC + lonH * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      const lat = latC + latH * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
      let [x, y, z] = proj(lat, lon);
      if (z > maxZ) maxZ = z;
      if (z < 0) { const l = Math.hypot(x, y) || 1; x /= l; y /= l; }
      d += (i ? "L" : "M") + f3(x) + " " + f3(y);
    }
    return { d: d + "Z", vis: clamp01((maxZ + 0.02) / 0.12) };
  };
  // Affine frame of a flat sprite lying on the sphere at (lat, lon).
  const frame = (lat: number, lon: number, sc: number) => {
    const la = lat * D2R, lo = (lon + p.yaw) * D2R, q = proj(lat, lon);
    const e0 = Math.cos(lo), e1 = -Math.sin(lo) * sp;
    const n0 = -Math.sin(la) * Math.sin(lo), n1 = Math.cos(la) * cp - Math.sin(la) * Math.cos(lo) * sp;
    return { m: `matrix(${f3(e0 * sc)} ${f3(-e1 * sc)} ${f3(-n0 * sc)} ${f3(n1 * sc)} ${f3(q[0])} ${f3(q[1])})`, z: q[2] };
  };
  const visor = region(0, 64, 2, 24, 4, 64);
  const gloss = region(-22, 32, 18, 3.6, 4, 32);
  const eye = (side: number): EyeGeo => {
    const f = frame(2, side * 22 + p.lead, 0.024), v = clamp01(f.z / 0.25);
    return {
      m: f.m,
      t: `scale(1 ${f3(p.blink)}) rotate(${f3(45 * p.tw)}) scale(${f3(1 + 0.25 * p.tw)})`,
      o: f3(v * (1 - p.happy)),
      go: f3(0.35 * v * (1 - p.happy)),
      po: f3(v * p.happy),
    };
  };
  const mark = frame(8, 180, 0.0034);
  return {
    roll: `rotate(${f3(p.roll)})`,
    markM: mark.m, markO: f3(0.55 * clamp01(mark.z / 0.3)),
    visor: visor.d, vis: f3(visor.vis),
    gloss: gloss.d, glo: f3(0.16 * gloss.vis),
    L: eye(-1), R: eye(1),
  };
}

// Module scope lives exactly as long as the page: a reload greets again, moving
// between the site's pages (client-side) does not.
let greetedThisLoad = false;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const STAR = "M0 -11C1 -4 3 -1 10 0C3 1 1 4 0 11C-1 4-3 1-10 0C-3-1-1-4 0-11Z";
const PEAK = "M-8.5 4.5L0-4.5L8.5 4.5";
const LOGO =
  "M96.6 97.4L82.7 112.3L113.9 144H101C94.3 144 87.9 141.4 83.1 136.6L58.3 112.3L84.7 85.9L70.2 71.3L42.2 99.4C37.4 104.2 30.9 106.9 24.1 106.9H11.4L70.2 48L96.6 73.9L122.8 48L180.6 106.9H168.3C161.4 106.9 154.8 104.1 150 99.2L122.8 71.3L108 85.9L146.9 125.1H134.5C127.6 125.1 121.1 122.3 116.2 117.4L96.6 97.4Z";

// One shared rest geometry: every message avatar shows it, so a long chat computes it once.
let restGeo: Geo | null = null;
const restGeometry = () => (restGeo ??= geometry(REST));

type EyeRefs = { g: SVGGElement | null; star: SVGPathElement | null; glow: SVGPathElement | null; peak: SVGPathElement | null };

type MascotProps = {
  /** On screen (the launcher not hidden behind the panel or a host modal; the panel open). */
  active: boolean;
  /**
   * "greet" (launcher): the 180° greeting once per page load, then slow blinks.
   * "hello" (panel header): a twinkle and a nod each time it becomes active, then slow blinks.
   */
  intro?: "greet" | "hello";
  /** A still face: no motion at all. */
  still?: boolean;
};

export const Mascot = memo(function Mascot({ active, intro = "greet", still = false }: MascotProps) {
  // Not greeted yet: start showing the back of the head, the greeting's first frame.
  const [willGreet] = useState(() => intro === "greet" && !still && !greetedThisLoad && !prefersReducedMotion());
  const [initial] = useState(() => (willGreet ? geometry(poseAt(0)) : restGeometry()));
  const orbRef = useRef<HTMLSpanElement>(null);
  const rollRef = useRef<SVGGElement>(null);
  const markRef = useRef<SVGGElement>(null);
  const visorRef = useRef<SVGPathElement>(null);
  const rimRef = useRef<SVGPathElement>(null);
  const glossRef = useRef<SVGPathElement>(null);
  const eyes = useRef<{ L: EyeRefs; R: EyeRefs }>({
    L: { g: null, star: null, glow: null, peak: null },
    R: { g: null, star: null, glow: null, peak: null },
  });

  useEffect(() => {
    if (!active || still) return;
    const set = (el: Element | null, name: string, value: string) => el?.setAttribute(name, value);
    const apply = (g: Geo) => {
      set(rollRef.current, "transform", g.roll);
      set(markRef.current, "transform", g.markM);
      set(markRef.current, "opacity", g.markO);
      set(visorRef.current, "d", g.visor);
      set(visorRef.current, "opacity", g.vis);
      set(rimRef.current, "d", g.visor);
      set(rimRef.current, "opacity", g.vis);
      set(glossRef.current, "d", g.gloss);
      set(glossRef.current, "opacity", g.glo);
      (["L", "R"] as const).forEach((side) => {
        const r = eyes.current[side], e = g[side];
        set(r.g, "transform", e.m);
        set(r.star, "transform", e.t);
        set(r.star, "opacity", e.o);
        set(r.glow, "transform", `${e.t} scale(1.35)`);
        set(r.glow, "opacity", e.go);
        set(r.peak, "opacity", e.po);
      });
    };

    // While the greeting is pending or playing, hover/focus leave the face alone
    // (styles.css): the happy eyes would otherwise show on the back of the head.
    const greetingOver = () => orbRef.current?.removeAttribute("data-greeting");

    if (prefersReducedMotion()) {
      greetedThisLoad = true;
      apply(geometry(REST));
      greetingOver();
      return;
    }

    let raf = 0, timer = 0, cancelled = false;
    // Plays `pose(t)` for `seconds`. Elapsed time advances by at most 50 ms per
    // frame, so a tab that goes to the background resumes instead of skipping.
    const play = (seconds: number, pose: (t: number) => Pose, done: () => void) => {
      let t = 0, last = 0;
      const step = (now: number) => {
        if (cancelled) return;
        t += last ? Math.min(now - last, 50) / 1000 : 0;
        last = now;
        apply(geometry(pose(Math.min(t, seconds))));
        if (t >= seconds) done();
        else raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const scheduleBlink = () => {
      timer = window.setTimeout(() => {
        if (document.visibilityState !== "visible") return scheduleBlink();
        play(0.45, (t) => ({ ...REST, blink: track(BLINK_KEYS, t) }), scheduleBlink);
      }, 5000 + Math.random() * 2000);
    };
    const start = () => {
      if (intro === "hello") return play(HELLO_SECONDS, helloAt, scheduleBlink);
      if (greetedThisLoad) return scheduleBlink();
      greetedThisLoad = true;
      play(GREETING_SECONDS, poseAt, () => { greetingOver(); scheduleBlink(); });
    };
    // A page opened in a background tab greets when the visitor first looks at it.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisible);
      start();
    };
    if (document.visibilityState === "visible") start();
    else document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      // Hidden mid-greeting (opened at once, or a host sheet): come back facing the visitor.
      if (greetedThisLoad || intro === "hello") { apply(geometry(REST)); greetingOver(); }
    };
  }, [active, intro, still]);

  const eye = (side: "L" | "R") => {
    const e = initial[side], r = eyes.current[side];
    return (
      <g ref={(el) => { r.g = el; }} transform={e.m}>
        <path className="mc-glow" ref={(el) => { r.glow = el; }} d={STAR} transform={`${e.t} scale(1.35)`} fill="#c9dcff" opacity={e.go} />
        <path className="mc-star" ref={(el) => { r.star = el; }} d={STAR} transform={e.t} fill="#ffffff" opacity={e.o} />
        <path className="mc-peak" ref={(el) => { r.peak = el; }} d={PEAK} fill="none" stroke="#ffffff" strokeWidth={4.6} strokeLinecap="round" strokeLinejoin="round" opacity={e.po} />
      </g>
    );
  };

  return (
    <span ref={orbRef} className="mc-orb" aria-hidden="true" data-greeting={willGreet ? "" : undefined}>
      <svg viewBox="-1 -1 2 2" focusable="false">
        <g className="mc-tilt">
          <g ref={rollRef} transform={initial.roll}>
            <g ref={markRef} transform={initial.markM} opacity={initial.markO}>
              <path transform="translate(-96 -96)" d={LOGO} fill="#ffffff" />
            </g>
            <path ref={visorRef} d={initial.visor} fill="#101b52" opacity={initial.vis} />
            <path ref={rimRef} d={initial.visor} fill="none" stroke="#b3c9ff" strokeOpacity={0.55} strokeWidth={0.022} opacity={initial.vis} />
            <path ref={glossRef} d={initial.gloss} fill="#ffffff" opacity={initial.glo} />
            {eye("L")}
            {eye("R")}
          </g>
        </g>
      </svg>
      <span className="mc-orb-shine" />
      <span className="mc-orb-dot" />
    </span>
  );
});
