/**
 * A small G-code reader for the print visualiser.
 *
 * This exists so the dashboard can show *what the printer is actually doing*
 * when the camera is unavailable: which layer is being printed, its shape, and
 * where the nozzle is. Every number it draws comes from the real sliced file
 * and OctoPrint's real byte position in that file — nothing is simulated.
 *
 * The key idea: OctoPrint reports `job.progress.filepos`, the byte offset it
 * has reached in the G-code. If we record the byte range each layer occupies
 * while parsing, that offset maps straight back to a layer and to a position
 * along that layer's path.
 *
 * Deliberately not a full G-code interpreter:
 *  - G0/G1 linear moves, G2/G3 arcs drawn as their chord (documented, minor
 *    visual difference on rounded parts only).
 *  - G90/G91 and M82/M83 positioning modes, and G92 position resets.
 *  - Only extruding moves become geometry; travel moves just break the path.
 *  - Arcs, splines, and anything exotic are approximated or skipped rather
 *    than failing the parse: a partial picture beats no picture.
 */

/** Bytes above this are refused outright — a Pi 3B has 1 GB of RAM. */
export const MAX_PARSE_BYTES = 25 * 1024 * 1024;

const PARAM = /([XYZEF])(-?\d*\.?\d+)/g;

/**
 * Parse sliced G-code into per-layer paths plus the byte range of each layer.
 *
 * @param {string} text     the whole G-code file
 * @param {object} [options]
 * @param {number} [options.maxPoints] hard ceiling on retained points
 * @returns {{layers: {z:number,startByte:number,endByte:number,paths:number[][]}[],
 *            bounds: {minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number},
 *            bytes:number, points:number, truncated:boolean, tolerance:number}}
 */
export function parseGcode(text, options = {}) {
  const maxPoints = options.maxPoints ?? 60000;
  const bytes = Buffer.byteLength(text);

  // Decimation tolerance: points closer together than this are merged. It
  // scales with file size so a 20 MB file costs about the same as a 1 MB one,
  // both to draw and to send down a phone connection.
  const tolerance = options.tolerance ?? Math.min(2.5, Math.max(0.12, (bytes / 1e6) * 0.22));

  const layers = [];
  const bounds = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity, maxZ: -Infinity,
  };

  let absolute = true;
  let absoluteE = true;
  let x = 0, y = 0, z = 0, e = 0;

  let layer = null;
  let path = null;        // the polyline currently being extruded
  let anchorX = 0, anchorY = 0;   // last point actually kept
  let points = 0;
  let truncated = false;
  let offset = 0;

  const startLayer = (zHeight, at) => {
    layer = { z: zHeight, startByte: at, endByte: at, paths: [] };
    layers.push(layer);
    path = null;
  };

  for (const rawLine of text.split('\n')) {
    const lineStart = offset;
    offset += Buffer.byteLength(rawLine) + 1;

    const semi = rawLine.indexOf(';');
    const line = (semi === -1 ? rawLine : rawLine.slice(0, semi)).trim().toUpperCase();
    if (!line) continue;

    // Positioning modes. Cheap string checks before the regex.
    if (line.startsWith('G90')) { absolute = true; continue; }
    if (line.startsWith('G91')) { absolute = false; continue; }
    if (line.startsWith('M82')) { absoluteE = true; continue; }
    if (line.startsWith('M83')) { absoluteE = false; continue; }

    const isMove = /^G[0123](?!\d)/.test(line);
    const isReset = /^G92(?!\d)/.test(line);
    if (!isMove && !isReset) continue;

    let nx = x, ny = y, nz = z, ne = e;
    let sawE = false;
    PARAM.lastIndex = 0;
    let match = PARAM.exec(line);
    while (match) {
      const value = Number(match[2]);
      if (Number.isFinite(value)) {
        switch (match[1]) {
          case 'X': nx = absolute || isReset ? value : x + value; break;
          case 'Y': ny = absolute || isReset ? value : y + value; break;
          case 'Z': nz = absolute || isReset ? value : z + value; break;
          case 'E': ne = absoluteE || isReset ? value : e + value; sawE = true; break;
          default: break;  // F, feedrate, does not move anything
        }
      }
      match = PARAM.exec(line);
    }

    if (isReset) {
      // G92 redefines the current position without moving.
      x = nx; y = ny; z = nz; e = ne;
      continue;
    }

    const extruding = sawE && ne > e + 1e-6;
    const moved = nx !== x || ny !== y;

    if (extruding && moved) {
      if (!layer || nz !== layer.z) startLayer(nz, lineStart);

      if (!path) {
        // A new path starts where the nozzle already is.
        path = [x, y];
        layer.paths.push(path);
        anchorX = x;
        anchorY = y;
        points += 1;
        if (bounds.minX > x) bounds.minX = x;
        if (bounds.maxX < x) bounds.maxX = x;
        if (bounds.minY > y) bounds.minY = y;
        if (bounds.maxY < y) bounds.maxY = y;
      }

      if (points >= maxPoints) {
        truncated = true;
      } else {
        const far = Math.hypot(nx - anchorX, ny - anchorY) >= tolerance;
        if (far) {
          path.push(nx, ny);
          anchorX = nx;
          anchorY = ny;
          points += 1;
        } else {
          // Merged into the anchor: overwrite the last point so the path
          // still ends where the nozzle really is.
          path[path.length - 2] = nx;
          path[path.length - 1] = ny;
        }
      }

      if (bounds.minX > nx) bounds.minX = nx;
      if (bounds.maxX < nx) bounds.maxX = nx;
      if (bounds.minY > ny) bounds.minY = ny;
      if (bounds.maxY < ny) bounds.maxY = ny;
      if (bounds.minZ > nz) bounds.minZ = nz;
      if (bounds.maxZ < nz) bounds.maxZ = nz;
    } else if (moved) {
      // A travel move ends the current path.
      path = null;
    }

    if (layer) layer.endByte = offset;
    x = nx; y = ny; z = nz; e = ne;
  }

  // A file with no extrusion at all (or only travels) leaves bounds at
  // infinity; hand back something the caller can safely divide by.
  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = 0; bounds.maxX = 0;
    bounds.minY = 0; bounds.maxY = 0;
    bounds.minZ = 0; bounds.maxZ = 0;
  }

  return { layers, bounds, bytes, points, truncated, tolerance };
}

/**
 * Where is the printer, given OctoPrint's byte offset into the file?
 *
 * @returns {{layer:number, z:number, fraction:number, x:number|null, y:number|null}|null}
 */
export function locate(model, filepos) {
  if (!model || !model.layers.length || !Number.isFinite(filepos)) return null;

  const layers = model.layers;
  let index = 0;

  if (filepos >= layers[layers.length - 1].endByte) {
    index = layers.length - 1;
  } else {
    // Binary search for the layer whose byte range contains filepos.
    let lo = 0;
    let hi = layers.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (filepos < layers[mid].startByte) hi = mid - 1;
      else if (filepos >= layers[mid].endByte) lo = mid + 1;
      else { lo = mid; break; }
    }
    index = Math.max(0, Math.min(layers.length - 1, lo));
  }

  const layer = layers[index];
  const span = Math.max(1, layer.endByte - layer.startByte);
  const fraction = Math.max(0, Math.min(1, (filepos - layer.startByte) / span));
  const point = pointAlongLayer(layer, fraction);

  return { layer: index, z: layer.z, fraction, x: point?.x ?? null, y: point?.y ?? null };
}

/**
 * Walk a layer's paths by length and return the point `fraction` of the way
 * along. Byte position within a layer is a decent proxy for distance printed:
 * both grow roughly with extruded length.
 */
export function pointAlongLayer(layer, fraction) {
  if (!layer || !layer.paths.length) return null;

  let total = 0;
  for (const path of layer.paths) {
    for (let i = 2; i < path.length; i += 2) {
      total += Math.hypot(path[i] - path[i - 2], path[i + 1] - path[i - 1]);
    }
  }
  if (total === 0) {
    const first = layer.paths[0];
    return { x: first[0], y: first[1] };
  }

  let target = total * Math.max(0, Math.min(1, fraction));
  for (const path of layer.paths) {
    for (let i = 2; i < path.length; i += 2) {
      const dx = path[i] - path[i - 2];
      const dy = path[i + 1] - path[i - 1];
      const length = Math.hypot(dx, dy);
      if (length >= target) {
        const t = length === 0 ? 0 : target / length;
        return { x: path[i - 2] + dx * t, y: path[i - 1] + dy * t };
      }
      target -= length;
    }
  }

  const last = layer.paths[layer.paths.length - 1];
  return { x: last[last.length - 2], y: last[last.length - 1] };
}

/**
 * Shrink the model for transport: coordinates to 0.01 mm as integers, which
 * roughly halves the JSON over a phone connection and costs nothing visually.
 */
export function serialiseModel(model) {
  return {
    bounds: {
      minX: round2(model.bounds.minX), maxX: round2(model.bounds.maxX),
      minY: round2(model.bounds.minY), maxY: round2(model.bounds.maxY),
      minZ: round2(model.bounds.minZ), maxZ: round2(model.bounds.maxZ),
    },
    bytes: model.bytes,
    points: model.points,
    truncated: model.truncated,
    layers: model.layers.map((layer) => ({
      z: round2(layer.z),
      paths: layer.paths.map((path) => path.map(round2)),
    })),
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
