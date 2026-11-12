import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';
import { SceneTransformSchema } from './shared-internal.js';

const length = z.number().min(0.001).max(10000);
const coordinate = z.number().min(-10000).max(10000);
const point = z.tuple([coordinate, coordinate, coordinate]);
const point2 = z.tuple([coordinate, coordinate]);
type Point2 = z.infer<typeof point2>;
const segments = z.number().int().min(3).max(128).default(24);
const dotCross = (a: Point2, b: Point2, c: Point2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function intersects(a: Point2, b: Point2, c: Point2, d: Point2) {
  const sign = (n: number) => (Math.abs(n) <= 1e-10 ? 0 : Math.sign(n));
  const within = (v: Point2, l: Point2, r: Point2) =>
    v.every(
      (x, i) => x >= Math.min(l[i]!, r[i]!) && x <= Math.max(l[i]!, r[i]!),
    );
  const [p, q, r, s] = [
    dotCross(a, b, c),
    dotCross(a, b, d),
    dotCross(c, d, a),
    dotCross(c, d, b),
  ].map(sign) as [number, number, number, number];
  return (
    (p * q < 0 && r * s < 0) ||
    (!p && within(c, a, b)) ||
    (!q && within(d, a, b)) ||
    (!r && within(a, c, d)) ||
    (!s && within(b, c, d))
  );
}

const PolygonSchema = z
  .array(point2)
  .min(3)
  .max(128)
  .superRefine((points, ctx) => {
    const next = (i: number) => points[(i + 1) % points.length]!;
    const area = points.reduce(
      (sum, a, i) => sum + a[0] * next(i)[1] - a[1] * next(i)[0],
      0,
    );
    const invalid =
      Math.abs(area) < 1e-10 ||
      points.some((a, i) => {
        const b = next(i);
        if (
          Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 ||
          Math.abs(dotCross(a, b, next(i + 1))) < 1e-10
        )
          return true;
        return points.some(
          (c, j) =>
            j > i + 1 &&
            !(i === 0 && j === points.length - 1) &&
            intersects(a, b, c, next(j)),
        );
      });
    if (invalid)
      ctx.addIssue({
        code: 'custom',
        message:
          'Expected a simple polygon with nonzero area and distinct, non-collinear corners',
      });
  });

const PathSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('polyline'),
        points: z.array(point).min(2).max(256),
      })
      .strict(),
    z
      .object({
        kind: z.literal('bezier'),
        start: point,
        segments: z
          .array(
            z.object({ control1: point, control2: point, end: point }).strict(),
          )
          .min(1)
          .max(16),
        stepsPerSegment: z.number().int().min(2).max(32).default(16),
      })
      .strict(),
  ])
  .superRefine((path, ctx) => {
    if (
      path.kind === 'polyline' &&
      path.points.some(
        (v, i) =>
          i > 0 &&
          Math.hypot(...v.map((x, j) => x - path.points[i - 1]![j]!)) < 1e-6,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Adjacent path points must be distinct',
      });
  });

export const MeshShapeSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('box'),
        dimensions: z.tuple([length, length, length]),
      })
      .strict(),
    z
      .object({
        kind: z.literal('sphere'),
        radius: length,
        segments,
        rings: z.number().int().min(4).max(64).default(12),
      })
      .strict(),
    z
      .object({
        kind: z.literal('cylinder'),
        radius: length,
        height: length,
        segments,
      })
      .strict(),
    z
      .object({
        kind: z.literal('cone'),
        radius: length,
        height: length,
        segments,
      })
      .strict(),
    z
      .object({
        kind: z.literal('extrusion'),
        polygon: PolygonSchema,
        depth: length,
      })
      .strict(),
    z
      .object({
        kind: z.literal('curve'),
        path: PathSchema,
        radius: length,
        sides: z.number().int().min(3).max(32).default(8),
      })
      .strict(),
    z
      .object({
        kind: z.literal('sweep'),
        path: PathSchema,
        profile: PolygonSchema,
        up: point.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('indexed'),
        vertices: z.array(point).min(3).max(16384),
        triangles: z
          .array(
            z.tuple([
              z.number().int().nonnegative(),
              z.number().int().nonnegative(),
              z.number().int().nonnegative(),
            ]),
          )
          .min(1)
          .max(32768),
      })
      .strict(),
  ])
  .superRefine((mesh, ctx) => {
    if (mesh.kind === 'sweep' && mesh.up && Math.hypot(...mesh.up) < 1e-6)
      ctx.addIssue({
        code: 'custom',
        path: ['up'],
        message: 'Sweep up vector must be nonzero',
      });
    if (mesh.kind === 'indexed') {
      const faces = new Set<string>();
      for (const [i, face] of mesh.triangles.entries()) {
        const key = [...face].sort((a, b) => a - b).join(':');
        const [a, b, c] = face.map((index) => mesh.vertices[index]);
        const u = a && b ? b.map((n, j) => n - a[j]!) : [];
        const v = a && c ? c.map((n, j) => n - a[j]!) : [];
        if (
          !a ||
          !b ||
          !c ||
          faces.has(key) ||
          Math.hypot(
            u[1]! * v[2]! - u[2]! * v[1]!,
            u[2]! * v[0]! - u[0]! * v[2]!,
            u[0]! * v[1]! - u[1]! * v[0]!,
          ) < 1e-10
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['triangles', i],
            message: 'Invalid, duplicate or degenerate indexed triangle',
          });
          break;
        }
        faces.add(key);
      }
    }
  });

export const MeshDefinitionSchema = z
  .object({
    id: StableIdSchema,
    materialId: StableIdSchema,
    shape: MeshShapeSchema,
  })
  .strict();

export const AssemblyDefinitionSchema = z
  .object({
    id: StableIdSchema,
    parts: z
      .array(
        z
          .object({
            id: StableIdSchema,
            parentId: StableIdSchema.optional(),
            meshId: StableIdSchema,
            transform: SceneTransformSchema,
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();

/** Slot names are the source material names, or replace every mesh slot with all. */
export const ImportedMaterialsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all'), materialId: StableIdSchema }).strict(),
  z
    .object({
      mode: z.literal('slots'),
      slots: z
        .array(
          z
            .object({
              source: z.string().trim().min(1).max(256),
              materialId: StableIdSchema,
            })
            .strict(),
        )
        .min(1)
        .max(128),
    })
    .strict(),
]);
