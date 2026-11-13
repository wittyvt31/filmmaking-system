import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProceduralAssetDefinition } from '@filmmaking/web-api/types';

type Vec3 = [number, number, number];
type Shape = ProceduralAssetDefinition['meshes'][number]['shape'];
type Part = ProceduralAssetDefinition['parts'][number];
type Surface = { points: Vec3[]; color: Vec3; partId: string };
type Camera = { yaw: number; elevation: number; zoom: number };

const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
const subtract = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normal = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

function rotate(point: Vec3, degrees: { x: number; y: number; z: number }): Vec3 {
  const [x, y, z] = [degrees.x, degrees.y, degrees.z].map(
    (value) => (value * Math.PI) / 180,
  );
  const a: Vec3 = [
    point[0],
    point[1] * Math.cos(x) - point[2] * Math.sin(x),
    point[1] * Math.sin(x) + point[2] * Math.cos(x),
  ];
  const b: Vec3 = [
    a[0] * Math.cos(y) + a[2] * Math.sin(y),
    a[1],
    -a[0] * Math.sin(y) + a[2] * Math.cos(y),
  ];
  return [
    b[0] * Math.cos(z) - b[1] * Math.sin(z),
    b[0] * Math.sin(z) + b[1] * Math.cos(z),
    b[2],
  ];
}

function transformPoint(
  point: Vec3,
  part: Part,
  parents: ReadonlyMap<string, Part>,
): Vec3 {
  let result: Vec3 = point;
  let current: Part | undefined = part;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const { position, rotationDegrees, scale } = current.transform;
    result = add(
      rotate(
        [result[0] * scale, result[1] * scale, result[2] * scale],
        rotationDegrees,
      ),
      [position.x, position.y, position.z],
    );
    current = current.parentId ? parents.get(current.parentId) : undefined;
  }
  return result;
}

function shapeSurfaces(shape: Shape): Vec3[][] {
  if (shape.kind === 'box') {
    const [x, y, z] = shape.dimensions.map((value) => value / 2);
    const v: Vec3[] = [
      [-x, -y, -z],
      [x, -y, -z],
      [x, y, -z],
      [-x, y, -z],
      [-x, -y, z],
      [x, -y, z],
      [x, y, z],
      [-x, y, z],
    ];
    return [
      [v[0]!, v[3]!, v[2]!, v[1]!],
      [v[4]!, v[5]!, v[6]!, v[7]!],
      [v[0]!, v[1]!, v[5]!, v[4]!],
      [v[1]!, v[2]!, v[6]!, v[5]!],
      [v[2]!, v[3]!, v[7]!, v[6]!],
      [v[3]!, v[0]!, v[4]!, v[7]!],
    ];
  }

  if (shape.kind === 'cylinder' || shape.kind === 'cone') {
    const segments = Math.min(shape.segments, 48);
    const bottom: Vec3[] = [];
    const top: Vec3[] = [];
    for (let i = 0; i < segments; i += 1) {
      const a = (2 * Math.PI * i) / segments;
      bottom.push([
        Math.cos(a) * shape.radius,
        Math.sin(a) * shape.radius,
        -shape.height / 2,
      ]);
      top.push([
        Math.cos(a) * (shape.kind === 'cone' ? 0 : shape.radius),
        Math.sin(a) * (shape.kind === 'cone' ? 0 : shape.radius),
        shape.height / 2,
      ]);
    }
    return [
      [...bottom].reverse(),
      ...(shape.kind === 'cone' ? [] : [top]),
      ...bottom.map((point, i) => [
        point,
        bottom[(i + 1) % segments]!,
        top[(i + 1) % segments]!,
        top[i]!,
      ]),
    ];
  }

  if (shape.kind === 'sphere') {
    const segments = Math.min(shape.segments, 36);
    const rings = Math.min(shape.rings, 24);
    const point = (ring: number, sector: number): Vec3 => {
      const phi = (Math.PI * ring) / rings;
      const theta = (2 * Math.PI * sector) / segments;
      return [
        shape.radius * Math.sin(phi) * Math.cos(theta),
        shape.radius * Math.sin(phi) * Math.sin(theta),
        shape.radius * Math.cos(phi),
      ];
    };
    const faces: Vec3[][] = [];
    for (let ring = 0; ring < rings; ring += 1)
      for (let sector = 0; sector < segments; sector += 1)
        faces.push([
          point(ring, sector),
          point(ring + 1, sector),
          point(ring + 1, sector + 1),
          point(ring, sector + 1),
        ]);
    return faces;
  }

  if (shape.kind === 'indexed')
    return shape.triangles.map((triangle) =>
      triangle.map((index) => [...shape.vertices[index]!] as Vec3),
    );

  if (shape.kind === 'extrusion') {
    const base = shape.polygon.map(
      ([x, y]): Vec3 => [x, y, 0],
    );
    const top = shape.polygon.map(
      ([x, y]): Vec3 => [x, y, shape.depth],
    );
    return [
      [...base].reverse(),
      top,
      ...base.map((vertex, index) => [
        vertex,
        base[(index + 1) % base.length]!,
        top[(index + 1) % top.length]!,
        top[index]!,
      ]),
    ];
  }
  // The Blender preview is authoritative for curves and sweeps.
  return [];
}

function buildSurfaces(definition: ProceduralAssetDefinition) {
  const parts = new Map(definition.parts.map((part) => [part.id, part]));
  const meshes = new Map(definition.meshes.map((mesh) => [mesh.id, mesh]));
  const materials = new Map(
    definition.materials.map((material) => [material.id, material]),
  );
  const surfaces: Surface[] = [];
  const centers = new Map<string, Vec3>();
  let unsupported = 0;
  for (const part of definition.parts) {
    const mesh = meshes.get(part.meshId);
    if (!mesh) continue;
    const color: Vec3 = (materials.get(mesh.materialId)?.color ??
      [0.65, 0.72, 0.8]) as Vec3;
    const polygons = shapeSurfaces(mesh.shape);
    if (!polygons.length) unsupported += 1;
    centers.set(part.id, transformPoint([0, 0, 0], part, parts));
    for (const polygon of polygons)
      surfaces.push({
        partId: part.id,
        color,
        points: polygon.map((point) => transformPoint(point, part, parts)),
      });
  }
  return { surfaces, centers, unsupported };
}

function project(
  point: Vec3,
  center: Vec3,
  camera: Camera,
  width: number,
  height: number,
  scale: number,
): [number, number, number] {
  const delta = subtract(point, center);
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const ce = Math.cos(camera.elevation);
  const se = Math.sin(camera.elevation);
  const horizontal = delta[0] * cy - delta[1] * sy;
  const depth = delta[0] * sy + delta[1] * cy;
  const vertical = delta[2] * ce - depth * se;
  return [
    width / 2 + horizontal * scale,
    height / 2 - vertical * scale,
    delta[2] * se + depth * ce,
  ];
}

function render(
  canvas: HTMLCanvasElement,
  definition: ReturnType<typeof buildSurfaces>,
  camera: Camera,
  selected: string,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.clientWidth || 640;
  const height = canvas.clientHeight || 400;
  const ratio = window.devicePixelRatio || 1;
  if (
    canvas.width !== Math.round(width * ratio) ||
    canvas.height !== Math.round(height * ratio)
  ) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0d141d';
  ctx.fillRect(0, 0, width, height);
  const points = definition.surfaces.flatMap((face) => face.points);
  if (!points.length) return;
  const boundsMin: Vec3 = [0, 1, 2].map((axis) =>
    Math.min(...points.map((point) => point[axis]!)),
  ) as Vec3;
  const boundsMax: Vec3 = [0, 1, 2].map((axis) =>
    Math.max(...points.map((point) => point[axis]!)),
  ) as Vec3;
  const center: Vec3 = add(boundsMin, boundsMax).map(
    (value) => value / 2,
  ) as Vec3;
  const span = Math.max(1, Math.hypot(...subtract(boundsMax, boundsMin)));
  const scale = (Math.min(width, height) * 0.78 * camera.zoom) / span;
  const perspective = (point: Vec3) =>
    project(point, center, camera, width, height, scale);

  ctx.strokeStyle = '#304456';
  ctx.lineWidth = 1;
  const gridSize = Math.max(1, Math.ceil(span / 2));
  const z = boundsMin[2] - 0.12;
  for (let i = -gridSize; i <= gridSize; i += Math.max(0.5, gridSize / 8)) {
    const lineA: Vec3 = [center[0] + i, center[1] - gridSize, z];
    const lineB: Vec3 = [center[0] + i, center[1] + gridSize, z];
    const lineC: Vec3 = [center[0] - gridSize, center[1] + i, z];
    const lineD: Vec3 = [center[0] + gridSize, center[1] + i, z];
    for (const [from, to] of [[lineA, lineB], [lineC, lineD]]) {
      const a = perspective(from!);
      const b = perspective(to!);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }

  const sorted = definition.surfaces
    .map((face) => ({
      ...face,
      vertices: face.points.map(perspective),
    }))
    .sort(
      (a, b) =>
        a.vertices.reduce((sum, p) => sum + p[2], 0) / a.vertices.length -
        b.vertices.reduce((sum, p) => sum + p[2], 0) / b.vertices.length,
    );

  for (const face of sorted) {
    if (face.points.length < 3) continue;
    const surfaceNormal = normal(
      cross(
        subtract(face.points[1]!, face.points[0]!),
        subtract(face.points[2]!, face.points[0]!),
      ),
    );
    const light = Math.max(0.25, Math.min(1, 0.62 + dot(surfaceNormal, normal([0.4, -0.6, 0.85])) * 0.35));
    ctx.fillStyle =
      'rgb(' +
      face.color
        .map((value) => Math.round(Math.max(0, Math.min(1, value * light)) * 255))
        .join(',') +
      ')';
    ctx.beginPath();
    ctx.moveTo(face.vertices[0]![0], face.vertices[0]![1]);
    for (const [x, y] of face.vertices.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle =
      face.partId === selected ? '#f9c981' : 'rgba(255,255,255,0.11)';
    ctx.lineWidth = face.partId === selected ? 1.5 : 0.7;
    ctx.stroke();
  }
}

export function AssetViewport({
  definition,
  selected,
  onSelect,
}: {
  definition: ProceduralAssetDefinition;
  selected: string;
  onSelect: (partId: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [camera, setCamera] = useState<Camera>({
    yaw: 0.8,
    elevation: 0.4,
    zoom: 1,
  });
  const [size, setSize] = useState(0);
  const model = useMemo(() => buildSurfaces(definition), [definition]);

  useEffect(() => {
    if (canvas.current) render(canvas.current, model, camera, selected);
  }, [model, camera, selected, size]);

  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(() => setSize((value) => value + 1));
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="asset-viewport">
      <canvas
        ref={canvas}
        aria-label="Interactive 3D procedural asset preview. Drag to orbit and scroll to zoom."
        role="img"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, y: event.clientY, moved: false };
        }}
        onPointerMove={(event) => {
          const last = drag.current;
          if (!last) return;
          const dx = event.clientX - last.x;
          const dy = event.clientY - last.y;
          if (Math.abs(dx) + Math.abs(dy) > 1) last.moved = true;
          last.x = event.clientX;
          last.y = event.clientY;
          setCamera((current) => ({
            ...current,
            yaw: current.yaw + dx * 0.008,
            elevation: Math.max(-1.45, Math.min(1.45, current.elevation + dy * 0.008)),
          }));
        }}
        onPointerUp={(event) => {
          if (drag.current && !drag.current.moved && canvas.current) {
            const bounds = canvas.current.getBoundingClientRect();
            const x = event.clientX - bounds.left;
            const y = event.clientY - bounds.top;
            const points = model.surfaces.flatMap((face) => face.points);
            if (points.length) {
              const minimum: Vec3 = [0, 1, 2].map((axis) =>
                Math.min(...points.map((point) => point[axis]!)),
              ) as Vec3;
              const maximum: Vec3 = [0, 1, 2].map((axis) =>
                Math.max(...points.map((point) => point[axis]!)),
              ) as Vec3;
              const center = add(minimum, maximum).map((value) => value / 2) as Vec3;
              const span = Math.max(1, Math.hypot(...subtract(maximum, minimum)));
              const scale = (Math.min(bounds.width, bounds.height) * 0.78 * camera.zoom) / span;
              const nearest = [...model.centers.entries()]
                .map(([id, point]) => {
                  const screen = project(point, center, camera, bounds.width, bounds.height, scale);
                  return { id, distance: Math.hypot(screen[0] - x, screen[1] - y) };
                })
                .sort((a, b) => a.distance - b.distance)[0];
              if (nearest && nearest.distance < 45) onSelect(nearest.id);
            }
          }
          drag.current = null;
        }}
        onPointerCancel={() => { drag.current = null; }}
        onWheel={(event) => {
          event.preventDefault();
          setCamera((current) => ({
            ...current,
            zoom: Math.max(0.35, Math.min(4, current.zoom * (event.deltaY > 0 ? 0.92 : 1.08))),
          }));
        }}
      />
      <div className="viewport-caption">
        <span>DRAG · ORBIT &nbsp; SCROLL · ZOOM</span>
        <button onClick={() => setCamera({ yaw: 0.8, elevation: 0.4, zoom: 1 })}>
          Reset view
        </button>
      </div>
      {model.unsupported > 0 && (
        <p className="viewport-note">
          {model.unsupported} advanced mesh(es) require a generated Blender preview.
        </p>
      )}
    </div>
  );
}
