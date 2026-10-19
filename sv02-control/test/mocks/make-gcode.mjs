/**
 * Generates a small G-code file with a deliberately different shape on each
 * layer — square, circle, triangle, star — so the layer view can be checked
 * by eye as well as by assertion. If the viewer ever draws the wrong layer,
 * the shape makes it obvious immediately.
 */
export function makeGcode() {
  const lines = ['; test print', 'G21', 'G90', 'M82', 'G28'];
  let e = 0;

  const move = (x, y, extrude) => {
    if (extrude) {
      e += 0.5;
      lines.push(`G1 X${x.toFixed(2)} Y${y.toFixed(2)} E${e.toFixed(3)}`);
    } else {
      lines.push(`G0 X${x.toFixed(2)} Y${y.toFixed(2)}`);
    }
  };

  const shapes = {
    square: (cx, cy, r) => [
      [cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r], [cx - r, cy - r],
    ],
    circle: (cx, cy, r) => Array.from({ length: 33 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    }),
    triangle: (cx, cy, r) => [
      [cx, cy + r], [cx + r, cy - r], [cx - r, cy - r], [cx, cy + r],
    ],
    star: (cx, cy, r) => Array.from({ length: 11 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.45;
      return [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad];
    }),
  };

  const order = ['square', 'circle', 'triangle', 'star'];

  order.forEach((name, layer) => {
    const z = 0.2 + layer * 0.2;
    lines.push(`;LAYER:${layer}`);
    lines.push(`G1 Z${z.toFixed(2)}`);

    const points = shapes[name](100, 100, 20);
    move(points[0][0], points[0][1], false); // travel to the start
    for (const [x, y] of points.slice(1)) move(x, y, true);
  });

  lines.push('M104 S0', 'M140 S0', 'G28 X0 Y0', 'M84');
  return `${lines.join('\n')}\n`;
}

export const SHAPE_ORDER = ['square', 'circle', 'triangle', 'star'];

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(makeGcode());
}
