# Can the SV02 use its nozzle as a probe, like a Prusa?

**Short answer: not with the stock toolhead.** What Prusa does depends on a
sensor built into the extruder, and the SV02's extruder has nowhere to put
one. But the thing you actually want — never levelling the bed by hand again —
is very achievable, and there are three routes to it.

---

## What Prusa is actually doing

It's worth being precise, because "Prusa uses the nozzle as the probe" is
true of some Prusas and not others.

- **MK3 / MK3S** used a **PINDA / SuperPINDA**: an inductive sensor next to
  the hotend that senses the steel sheet. The nozzle is *not* the probe. This
  is the same category as a BLTouch — a separate sensor with an offset.

- **MK4, MK4S, MK3.9, XL, Core One** use the **Nextruder**, which has a
  **load cell** built into the hotend heatsink. The toolhead presses the
  nozzle down onto the sheet, and the load cell measures the *force* of that
  contact. When force crosses a threshold, that's Z=0.

That second design is the interesting one, and the reason it's good is
structural, not incremental:

- **Zero X/Y offset.** The probe point *is* the print point. No probe offset
  to calibrate, and no error from the offset being slightly wrong.
- **Surface-independent.** An inductive probe senses metal, so a textured
  PEI sheet, a glass bed, or a garolite sheet all change its behaviour. Force
  is force — the load cell doesn't care what the bed is made of.
- **No thermal drift in the sensor geometry.** PINDA's trigger height moves
  as it heats up, which is why MK3 owners preheat before probing.
- **It measures the real thing.** Nozzle-to-bed distance is what you care
  about, and it's what gets measured, rather than being inferred.

The cost: it depends on nozzle cleanliness. A blob of oozed filament on the
nozzle tip reads as the bed being higher than it is. Prusa's firmware and
Klipper both fight this, and Klipper's own docs call nozzle/bed fouling the
number one source of probing error with a load cell probe.

---

## Where that leaves the SV02

Your SV02 has:

- An **MKS Robin Nano** 32-bit board
- **Marlin 2.0** from Sovol
- A **dual-extruder** carriage — two hotends side by side
- **Manual bed levelling** with the four knobs, out of the box

There is no load cell in that toolhead, and no sane place to add one: a load
cell probe needs the hotend mounted on a defined flexure so that contact force
transfers into the sensor and nothing else does. That's a mechanical redesign
of the carriage, and the SV02's dual-hotend carriage makes it worse — you'd
need to solve it *twice*, once per nozzle, or accept that only one nozzle is
ever the probe.

So: the honest answer on true nozzle-as-probe is that it's a build project,
not an upgrade.

---

## Three options, ranked by effort

### Option 1 — BLTouch / CR Touch (do this one)

A small pin that deploys, touches the bed, retracts. Sovol sells an
**official BLTouch kit for the SV02**, which is the thing that makes this
easy: it comes with a bracket that fits, a wiring harness that plugs in, and
a matching firmware `.hex`.

**Effort:** an afternoon. **Cost:** roughly $15–40.

What you're signing up for:

1. Mount the bracket and probe on the carriage.
2. Plug the harness into the board's Z-probe/servo header.
3. Flash the SV02 BLTouch firmware — for this board that means putting the
   firmware file on the SD card and power-cycling.
4. **Also flash the display firmware.** This is SV02-specific and catches
   people out: the SV02's screen has its own firmware that needs updating
   alongside the mainboard, or the new menu options won't appear.
5. Set the Z-offset (`M851 Z-x.xx`, then `M500`), and run `G29` to build a
   mesh.
6. Add `G29` to your slicer's start G-code so it meshes before each print.

**What you gain:** the bed is measured and compensated automatically, and
you stop chasing the knobs. **What you don't gain:** it's still a probe with
an X/Y offset from the nozzle, so the offset has to be right, and it senses
the bed a few millimetres away from where the nozzle actually is.

For the problem you're solving — "I don't want to level this thing by hand" —
this is the correct answer, and I'd stop here.

### Option 2 — Klipper + a load cell probe (the real Prusa answer)

**Load cell probing is now in mainline Klipper** (`[load_cell_probe]`,
merged from garethky's PR #6871), so this is no longer a fork-and-pray
situation. It works the way the Prusa does: probe on force, nozzle is the
probe, zero offset.

But read the requirements honestly:

- Convert the SV02 to **Klipper**. The MKS Robin Nano can run it, with a Pi
  as the host. This alone is a weekend, and you lose the stock touchscreen
  menus in exchange for a web interface.
- Add a **load cell and an ADC** (HX711, or better an ADS1220/HX717 for
  speed) wired to the host or an MCU.
- **Redesign and print a new toolhead mount** so the hotend is on a flexure
  that transfers contact force into the load cell and nothing else. This is
  the hard part, and on a dual-hotend carriage it's harder still.
- Calibrate trigger force, and expect to tune it. Even on MK4 hardware,
  people have had to recalibrate the cell and adjust force thresholds to get
  reliable Z homing.

**Effort:** weeks, and it's a real engineering project. **Verify before you
start** that your Klipper version documents `[load_cell_probe]`, since this
landed relatively recently.

### Option 3 — Klipper + an eddy-current scanner (the modern shortcut)

**Beacon** or **Cartographer** — a coil that senses the metal bed *through*
the PEI sheet, without touching it. Not nozzle-as-probe, but it sidesteps
most of what makes probes annoying:

- **No moving parts**, so nothing to wear out or fail to deploy.
- **Very fast** — it scans a dense mesh in seconds rather than tapping out a
  grid point by point.
- **Can compensate in real time** during the first layer.
- Genuinely more accurate than a BLTouch in practice.

Requires Klipper, costs more than a BLTouch (~$70–120), and needs the bed to
be metal underneath. If you were converting to Klipper anyway, this is the
better use of the effort than building a load cell mount.

---

## What I'd actually do

**Fit the official Sovol BLTouch kit.** It solves the problem you have, it's
supported hardware with a firmware build made for your printer, and it's done
in an afternoon.

Treat true nozzle-as-probe as a separate project for later, and only if you
convert to Klipper for other reasons — Klipper is worth having on its own for
input shaping and pressure advance, and *then* the probe question becomes
"load cell or Beacon?", which is a much easier decision to make once you're
already there.

One thing worth knowing either way: **auto bed levelling compensates for a
bad bed, it doesn't fix one.** Get the bed physically flat with the knobs
first, so the mesh is correcting fractions of a millimetre rather than
papering over a real tilt.

---

## How this connects to the app

The dashboard's **Maintenance** panel already has an **Auto bed level** button
that sends `G28` then `G29`. It's there now and does nothing useful until a
probe is fitted — once the BLTouch is on and the firmware is flashed, it
starts working with no change to this app.

Setting the Z-offset (`M851 Z-x.xx`) is deliberately *not* a button, because
it needs a value typed in and getting it wrong drives the nozzle into the
bed. Do that once from OctoPrint's terminal, follow it with **Save settings
to EEPROM** (which is a button, sending `M500`), and you won't need it again.

To add more commands, extend `MAINTENANCE_COMMANDS` in `server/index.js` —
it's a fixed allowlist rather than a G-code pass-through, on purpose.

---

## Sources

- [Loadcell (MK4/S, MK3.9/S, XL) — Prusa Knowledge Base](https://help.prusa3d.com/article/loadcell-mk4-s-mk3-9-s-xl_401253)
- [Announcing Original Prusa MK4 — Prusa blog](https://blog.prusa3d.com/announcing-original-prusa-mk4_76585/)
- [Klipper Load Cell Probe documentation](https://github.com/garethky/klipper/blob/adc-endstop/docs/Load_Cell_Probe.md)
- [Klipper PR #6871 — Load Cell Probe](https://github.com/Klipper3d/klipper/pull/6871)
- [Klipper Load Cells documentation](https://www.klipper3d.org/Load_Cell.html)
- [Strain Gauge / Load Cell based Endstops — Klipper Discourse](https://klipper.discourse.group/t/strain-gauge-load-cell-based-endstops/2134)
- [Sovol SV02 BLTouch kit](https://www.amazon.com/Sovol-Printer-Leveling-Sensor-BLTouch/dp/B08KXXT1C6)
- [SOVOL SV02 BL Touch User Manual](https://studylib.net/doc/25638087/bl-touch-user-manual-for-sv02)
- [Sovol SV02 wiki / firmware downloads](https://wiki.sovol3d.com/en/SV02)
- [Tutoriel : Installation du kit BL-Touch sur la Sovol SV02](https://leblog3d.fr/tutoriel-installation-du-kit-bl-touch-sur-la-sovol-sv02/)
