// What the showcase's young learners drew, as marks a child's crayon would make (see media.ts).
import type { Crayon, Drawing, Mark, Paint } from "./media.ts";

const sun = (x: number, y: number, r = 22): Mark[] => [
  { kind: "circle", x, y, r, crayon: "sun" },
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): Mark => {
    const a = (i * Math.PI) / 4;
    return { kind: "stroke", points: [[x + Math.cos(a) * (r + 6), y + Math.sin(a) * (r + 6)], [x + Math.cos(a) * (r + 18), y + Math.sin(a) * (r + 18)]], width: 4, crayon: "sun" };
  }),
];

const cloud = (x: number, y: number, crayon: Paint = "cloud"): Mark[] => [
  { kind: "circle", x, y, r: 16, crayon },
  { kind: "circle", x: x + 20, y: y - 8, r: 20, crayon },
  { kind: "circle", x: x + 42, y, r: 16, crayon },
  { kind: "rect", x, y, w: 42, h: 14, crayon },
];

const rain = (x: number, y: number, w: number, h: number): Mark[] =>
  Array.from({ length: Math.floor(w / 14) * Math.floor(h / 22) }, (_, i): Mark => {
    const col = i % Math.floor(w / 14), row = Math.floor(i / Math.floor(w / 14));
    const dx = x + col * 14 + (row % 2) * 7, dy = y + row * 22;
    return { kind: "stroke", points: [[dx, dy], [dx - 3, dy + 9]], width: 3, crayon: "rain" };
  });

const ground = (crayon: Crayon = "grass"): Mark[] => [{ kind: "rect", x: 0, y: 150, w: 240, h: 30, crayon }];

/** A child standing on the ground, centred on `x`, in a coat of `coat`, with what they wear. */
const child = (x: number, coat: Crayon, wear: { boots?: Crayon; hat?: Crayon; dinosaur?: boolean; umbrella?: Crayon } = {}): Mark[] => [
  // Legs, then boots.
  { kind: "stroke", points: [[x - 8, 120], [x - 10, 148]], width: 6, crayon: "blue" },
  { kind: "stroke", points: [[x + 8, 120], [x + 10, 148]], width: 6, crayon: "blue" },
  ...(wear.boots === undefined ? [] : [
    { kind: "rect", x: x - 18, y: 138, w: 14, h: 12, crayon: wear.boots },
    { kind: "rect", x: x + 4, y: 138, w: 14, h: 12, crayon: wear.boots },
  ] satisfies Mark[]),
  // Coat, arms and head.
  { kind: "shape", points: [[x - 16, 80], [x + 16, 80], [x + 22, 124], [x - 22, 124]], crayon: coat },
  { kind: "stroke", points: [[x - 16, 86], [x - 32, 108]], width: 6, crayon: coat },
  { kind: "stroke", points: [[x + 16, 86], [x + 30, 70]], width: 6, crayon: coat },
  { kind: "circle", x, y: 64, r: 16, crayon: "skin" },
  { kind: "circle", x: x - 6, y: 61, r: 2, crayon: "black" },
  { kind: "circle", x: x + 6, y: 61, r: 2, crayon: "black" },
  { kind: "stroke", points: [[x - 6, 70], [x, 73], [x + 6, 70]], width: 2, crayon: "black" },
  ...(wear.hat === undefined ? [] : [{ kind: "shape", points: [[x - 18, 54], [x + 18, 54], [x + 12, 40], [x - 12, 40]], crayon: wear.hat }] satisfies Mark[]),
  ...(wear.dinosaur !== true ? [] : [
    { kind: "shape", points: [[x - 18, 54], [x + 18, 54], [x + 14, 40], [x - 14, 40]], crayon: "green" },
    ...[-10, -2, 6].map((dx): Mark => ({ kind: "shape", points: [[x + dx, 40], [x + dx + 8, 40], [x + dx + 4, 30]], crayon: "orange" })),
  ] satisfies Mark[]),
  ...(wear.umbrella === undefined ? [] : [
    { kind: "stroke", points: [[x + 30, 70], [x + 30, 30]], width: 3, crayon: "black" },
    { kind: "shape", points: [[x - 4, 32], [x + 30, 8], [x + 64, 32]], crayon: wear.umbrella },
  ] satisfies Mark[]),
];

const sprout = (x: number): Mark[] => [
  { kind: "stroke", points: [[x, 150], [x, 116]], width: 5, crayon: "green" },
  { kind: "shape", points: [[x, 122], [x - 26, 108], [x - 6, 132]], crayon: "grass" },
  { kind: "shape", points: [[x, 118], [x + 28, 102], [x + 8, 128]], crayon: "grass" },
];

/** The drawings, by what they show. */
export const DRAWINGS = {
  sunnyDay: { paper: "sky", marks: [...ground(), ...sun(180, 44), ...cloud(30, 50, "white")] },
  rainyDay: { paper: "sky", marks: [...ground(), ...cloud(20, 36), ...cloud(120, 30), ...rain(16, 60, 210, 88)] },
  cloudyDay: { paper: "sky", marks: [...ground(), ...cloud(40, 60), ...cloud(130, 46)] },
  rainBootsAndUmbrella: { paper: "sky", marks: [...ground(), ...rain(10, 10, 220, 40), ...child(100, "yellow", { boots: "yellow", umbrella: "red" })] },
  dinosaurHat: { paper: "sky", marks: [...ground(), ...rain(10, 10, 220, 40), ...child(120, "blue", { boots: "red", dinosaur: true })] },
  seedSprout: { paper: "sky", marks: [...ground("soil"), ...sun(196, 40, 18), ...cloud(20, 40), ...rain(20, 66, 56, 40), ...sprout(120)] },
  seedInDirt: { paper: "sky", marks: [...ground("soil"), { kind: "circle", x: 120, y: 162, r: 6, crayon: "brown" }, ...cloud(90, 50)] },
  waterCycle: {
    paper: "sky",
    marks: [
      { kind: "rect", x: 0, y: 140, w: 240, h: 40, crayon: "rain" },
      ...sun(30, 34, 16),
      ...cloud(150, 40),
      ...rain(150, 76, 56, 50),
      // Evaporation rising from the water, and the arrow round the cycle.
      { kind: "stroke", points: [[70, 136], [64, 120], [72, 104], [66, 88]], width: 3, crayon: "purple" },
      { kind: "stroke", points: [[96, 136], [90, 120], [98, 104], [92, 88]], width: 3, crayon: "purple" },
      { kind: "stroke", points: [[80, 70], [120, 40], [140, 40]], width: 3, crayon: "black" },
      { kind: "shape", points: [[140, 34], [150, 40], [140, 46]], crayon: "black" },
    ],
  },
} as const satisfies Record<string, Drawing>;
