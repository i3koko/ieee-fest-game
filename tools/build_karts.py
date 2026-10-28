"""Builds Jam Kart's three karts in Blender and exports them as GLB.

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/build_karts.py -- public/models [preview_dir]
Jam Kart GP's versions, with wheel arches carved out of the body so the
suspension can move without the tyres poking through:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/build_karts.py -- public/models/gp --arches

Karts face -Y in Blender (+Z in glTF / three.js). Material names matter: the
game recolours "Paint" and "Glow" to the player's chosen colour, and spins the
objects named Wheel_*.
"""
import math
import os
import sys

import bmesh
import bpy

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ARCHES = '--arches' in args
args = [a for a in args if a != '--arches']
OUT = args[0] if args else 'public/models'
PREVIEW = args[1] if len(args) > 1 else None
ARCH_GAP = 0.2  # clearance between tyre and arch, for suspension travel
cutters = []

bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, metal=0.0, rough=0.5, emit=None, strength=1.0):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    bsdf = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    if emit:
        bsdf.inputs['Emission Color'].default_value = (*emit, 1)
        bsdf.inputs['Emission Strength'].default_value = strength
    return m


M = {
    'Paint': material('Paint', (0.8, 0.05, 0.05), metal=0.35, rough=0.3),
    'Glow': material('Glow', (0.02, 0.02, 0.02), emit=(0.2, 1.0, 1.0), strength=2.0),
    'Carbon': material('Carbon', (0.02, 0.022, 0.026), metal=0.2, rough=0.45),
    'Metal': material('Metal', (0.75, 0.77, 0.8), metal=1.0, rough=0.22),
    'Tyre': material('Tyre', (0.012, 0.012, 0.014), rough=0.85),
    'Trim': material('Trim', (0.9, 0.92, 0.95), metal=0.1, rough=0.3),
    'Visor': material('Visor', (0.01, 0.012, 0.02), metal=0.6, rough=0.08),
    'Lamp': material('Lamp', (1, 1, 1), emit=(1.0, 0.95, 0.85), strength=3.0),
    'Solar': material('Solar', (0.02, 0.05, 0.22), metal=0.7, rough=0.15),
}


def finish(o, mat, parent, bevel=0.0, smooth=False):
    if mat:
        o.data.materials.append(M[mat])
    if bevel:
        mod = o.modifiers.new('Bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
        mod.limit_method = 'ANGLE'
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = True
    o.parent = parent
    return o


def active():
    return bpy.context.view_layer.objects.active


def box(parent, size, loc, mat, bevel=0.04, rot=(0, 0, 0), name='Box'):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = active()
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, mat, parent, bevel)


def hull(parent, L, wr, wf, rz, fz, loc, mat, bevel=0.08, name='Hull'):
    """A box that tapers from the rear (+Y) to the front (-Y)."""
    bm = bmesh.new()
    vs = []
    for y, w, (z0, z1) in ((L / 2, wr, rz), (-L / 2, wf, fz)):
        for x in (-w / 2, w / 2):
            for z in (z0, z1):
                vs.append(bm.verts.new((x, y, z)))
    for f in ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (1, 3, 7, 5), (0, 4, 6, 2)):
        bm.faces.new([vs[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    o.location = loc
    return finish(o, mat, parent, bevel)


def cyl(parent, r, depth, loc, mat, rot=(0, 0, 0), verts=20, name='Cyl'):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, vertices=verts, location=loc, rotation=rot)
    o = active()
    o.name = name
    return finish(o, mat, parent, smooth=True)


def ball(parent, r, loc, mat, scale=(1, 1, 1), name='Ball'):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=24, ring_count=14, location=loc)
    o = active()
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, mat, parent, smooth=True)


def rod(parent, a, b, r, mat, name='Rod'):
    """Cylinder from point a to point b."""
    ax, ay, az = a
    bx, by, bz = b
    dx, dy, dz = bx - ax, by - ay, bz - az
    length = math.sqrt(dx * dx + dy * dy + dz * dz)
    o = cyl(parent, r, length, ((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), mat, verts=10, name=name)
    o.rotation_mode = 'QUATERNION'
    from mathutils import Vector
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(Vector((dx, dy, dz)))
    return o


def spokes(parts, sx, x, count, r_in, r_out, thick, wide, mat, twist=0.0):
    """`count` flat spokes radiating in the wheel's plane at axial offset x."""
    for n in range(count):
        a = n / count * 2 * math.pi
        mid = (r_in + r_out) / 2
        parts.append(box(None, (thick, r_out - r_in, wide), (x, math.cos(a) * mid, math.sin(a) * mid), mat, 0,
                         rot=(-a, twist * sx, 0)))


def ring(parts, x, radius, tube, mat):
    bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=tube, major_segments=36, minor_segments=8,
                                     location=(x, 0, 0), rotation=(0, math.pi / 2, 0))
    parts.append(finish(active(), mat, None, smooth=True))


def wheel(parent, name, loc, major, minor, width, style='f1'):
    """A wheel with its axle along X: a rounded slick tyre plus a rim. The
    original karts get a plain metal disc; Jam Kart GP's (--arches) get a rim
    design per kart, so each looks different and you can see it spin."""
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=36, minor_segments=12,
                                     location=(0, 0, 0), rotation=(0, math.pi / 2, 0))
    tyre = active()
    tyre.scale = (1, 1, 1)
    bpy.ops.object.transform_apply(rotation=True)
    tyre.scale = (width, 1, 1)
    bpy.ops.object.transform_apply(scale=True)
    finish(tyre, 'Tyre', None, smooth=True)
    tw = minor * width  # half the tyre's width
    if not ARCHES:
        parts = [cyl(None, major * 0.95, tw * 1.3, (0, 0, 0), 'Metal', rot=(0, math.pi / 2, 0), verts=24),
                 cyl(None, major * 0.35, tw * 1.5, (0, 0, 0), 'Glow', rot=(0, math.pi / 2, 0), verts=16)]
    else:
        # A dark barrel inside the rim, then the face on each side.
        parts = [cyl(None, major * 0.92, tw * 1.1, (0, 0, 0), 'Carbon', rot=(0, math.pi / 2, 0), verts=28)]
        for sx in (-1, 1):
            x = sx * tw * 0.62
            if style == 'f1':
                # Race car: black ten-spoke, glowing lip, centre-lock nut.
                ring(parts, x, major * 0.9, 0.028, 'Glow')
                spokes(parts, sx, x + sx * 0.01, 10, major * 0.15, major * 0.88, 0.04, 0.035, 'Carbon')
                parts.append(cyl(None, major * 0.14, 0.09, (x + sx * 0.03, 0, 0), 'Metal', rot=(0, math.pi / 2, 0), verts=6))
            elif style == 'buggy':
                # Chunky six-spoke with a glowing hub.
                ring(parts, x, major * 0.88, 0.045, 'Metal')
                spokes(parts, sx, x, 6, major * 0.2, major * 0.86, 0.07, 0.11, 'Metal')
                parts.append(cyl(None, major * 0.24, 0.08, (x + sx * 0.02, 0, 0), 'Glow', rot=(0, math.pi / 2, 0), verts=16))
            elif style == 'dish':
                # Heavy steel disc with bolt holes and lug nuts.
                parts.append(cyl(None, major * 0.86, 0.05, (x, 0, 0), 'Metal', rot=(0, math.pi / 2, 0), verts=32))
                for n in range(8):
                    a = n / 8 * 2 * math.pi
                    parts.append(cyl(None, major * 0.11, 0.07, (x + sx * 0.005, math.cos(a) * major * 0.56, math.sin(a) * major * 0.56),
                                     'Carbon', rot=(0, math.pi / 2, 0), verts=12))
                for n in range(6):
                    a = n / 6 * 2 * math.pi + 0.3
                    parts.append(cyl(None, 0.025, 0.08, (x + sx * 0.03, math.cos(a) * major * 0.24, math.sin(a) * major * 0.24),
                                     'Carbon', rot=(0, math.pi / 2, 0), verts=6))
                parts.append(cyl(None, major * 0.15, 0.08, (x + sx * 0.02, 0, 0), 'Metal', rot=(0, math.pi / 2, 0), verts=16))
            elif style == 'whitewall':
                # Classic: a white band on the sidewall and a chrome dome hubcap.
                ring(parts, sx * tw * 0.8, major + minor * 0.15, minor * 0.32, 'Trim')
                ring(parts, x, major * 0.88, 0.03, 'Metal')
                parts.append(cyl(None, major * 0.82, 0.03, (x, 0, 0), 'Metal', rot=(0, math.pi / 2, 0), verts=32))
                bpy.ops.mesh.primitive_uv_sphere_add(radius=major * 0.55, segments=24, ring_count=12, location=(x, 0, 0))
                dome = active()
                dome.scale = (0.35, 1, 1)
                bpy.ops.object.transform_apply(scale=True)
                parts.append(finish(dome, 'Metal', None, smooth=True))
            else:
                # Turbine: smooth aero disc, glowing ring, blades in the kart's paint.
                parts.append(cyl(None, major * 0.86, 0.04, (x, 0, 0), 'Carbon', rot=(0, math.pi / 2, 0), verts=32))
                ring(parts, x + sx * 0.02, major * 0.7, 0.025, 'Glow')
                spokes(parts, sx, x + sx * 0.03, 3, major * 0.12, major * 0.66, 0.05, 0.16, 'Paint', twist=0.5)
                parts.append(cyl(None, major * 0.13, 0.08, (x + sx * 0.03, 0, 0), 'Glow', rot=(0, math.pi / 2, 0), verts=16))
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts + [tyre]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = tyre
    bpy.ops.object.join()
    o = active()
    o.name = name
    o.location = loc
    o.parent = parent
    return o


def wheels(root, front, rear, major, minor, width, x_front, x_rear=None, style='f1'):
    x_rear = x_rear or x_front
    r = major + minor
    for name, x, y in (('FL', -x_front, front), ('FR', x_front, front), ('RL', -x_rear, rear), ('RR', x_rear, rear)):
        wheel(root, f'Wheel_{name}', (x, y, r), major, minor, width, style)
        if ARCHES:
            # A cylinder a little bigger than the tyre, used to carve its arch.
            bpy.ops.mesh.primitive_cylinder_add(radius=r + ARCH_GAP, depth=minor * width * 2 + 2 * ARCH_GAP, vertices=32,
                                                location=(x, y, r), rotation=(0, math.pi / 2, 0))
            c = active()
            c.name = 'ArchCutter'
            c.hide_render = True
            c.hide_set(True)
            cutters.append(c)


def carve_arches(k):
    """Cut every body part (not the wheels) clear of the arch cylinders."""
    global cutters
    for o in k.children_recursive:
        if o.type != 'MESH' or o.name.startswith('Wheel'):
            continue
        for c in cutters:
            mod = o.modifiers.new('Arch', 'BOOLEAN')
            mod.operation = 'DIFFERENCE'
            mod.solver = 'EXACT'
            mod.object = c
    cutters = []


def driver(root, loc):
    x, y, z = loc
    ball(root, 0.34, loc, 'Trim', name='Helmet')
    ball(root, 0.3, (x, y - 0.14, z + 0.02), 'Visor', scale=(0.95, 0.75, 0.5), name='Visor')


def root(name):
    o = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(o)
    return o


# ------------------------------------------------------------------ FIBER
def fiber():
    k = root('FIBER')
    box(k, (2.0, 3.6, 0.12), (0, 0, 0.34), 'Carbon', 0.03)
    hull(k, 3.4, 1.3, 0.5, (0.36, 0.95), (0.36, 0.55), (0, -0.15, 0), 'Paint', 0.1)
    hull(k, 1.2, 0.9, 0.7, (0.9, 1.22), (0.9, 1.0), (0, 0.95, 0), 'Paint', 0.1)
    for s in (-1, 1):
        hull(k, 1.8, 0.5, 0.38, (0.36, 0.8), (0.36, 0.58), (s * 0.86, 0.35, 0), 'Paint', 0.08)
        box(k, (0.05, 1.6, 0.05), (s * 1.12, 0.35, 0.62), 'Glow', 0)
        box(k, (0.06, 0.5, 0.26), (s * 1.15, -1.85, 0.4), 'Paint', 0.02)
        box(k, (0.06, 0.15, 0.5), (s * 0.4, 1.7, 1.1), 'Carbon', 0.01)
        box(k, (0.06, 0.62, 0.42), (s * 1.1, 1.75, 1.3), 'Carbon', 0.02)
        cyl(k, 0.09, 0.4, (s * 0.3, 1.78, 0.72), 'Metal', rot=(math.pi / 2, 0, 0))
        box(k, (0.22, 0.04, 0.08), (s * 0.45, -1.93, 0.5), 'Lamp', 0)
    box(k, (2.3, 0.45, 0.06), (0, -1.85, 0.3), 'Carbon', 0.02)
    box(k, (2.2, 0.5, 0.07), (0, 1.75, 1.35), 'Paint', 0.02)
    box(k, (2.0, 0.04, 0.04), (0, 2.0, 1.37), 'Glow', 0)
    # The "fibre": a light line running nose to tail.
    box(k, (0.07, 3.3, 0.03), (0, -0.2, 0.78), 'Glow', 0, rot=(math.atan2(0.4, 3.4), 0, 0))
    driver(k, (0, 0.3, 1.08))
    wheels(k, -1.25, 1.05, 0.3, 0.17, 1.5, 1.08, style='f1')
    return k


# ------------------------------------------------------------------ 5G
def five_g():
    k = root('5G')
    box(k, (1.6, 3.0, 0.12), (0, 0, 0.42), 'Carbon', 0.03)
    hull(k, 2.6, 1.3, 1.0, (0.42, 0.95), (0.42, 0.75), (0, 0, 0), 'Paint', 0.14)
    box(k, (1.4, 0.25, 0.25), (0, -1.62, 0.52), 'Carbon', 0.08)
    hull(k, 0.6, 1.0, 0.7, (0.45, 0.88), (0.45, 0.62), (0, -1.5, 0), 'Paint', 0.1)
    box(k, (0.75, 0.14, 0.6), (0, 0.48, 1.2), 'Carbon', 0.05)
    box(k, (1.0, 0.6, 0.5), (0, 1.25, 0.85), 'Carbon', 0.06)
    box(k, (0.8, 0.04, 0.06), (0, 1.56, 0.95), 'Glow', 0)
    for s in (-1, 1):
        rod(k, (s * 0.55, 0.45, 0.9), (s * 0.5, 0.35, 1.75), 0.04, 'Metal')
        rod(k, (s * 0.5, 0.35, 1.75), (s * 0.55, 1.2, 0.95), 0.04, 'Metal')
        box(k, (0.05, 2.0, 0.05), (s * 0.66, 0, 0.82), 'Glow', 0)
        box(k, (0.26, 0.05, 0.12), (s * 0.3, -1.81, 0.72), 'Lamp', 0)
        rod(k, (s * 0.78, -0.62, 0.58), (s * 0.78, 0.68, 0.58), 0.05, 'Metal')
        rod(k, (s * 0.66, -0.62, 0.58), (s * 0.78, -0.62, 0.58), 0.05, 'Metal')
        rod(k, (s * 0.66, 0.68, 0.58), (s * 0.78, 0.68, 0.58), 0.05, 'Metal')
    rod(k, (-0.5, 0.35, 1.75), (0.5, 0.35, 1.75), 0.04, 'Metal')
    # Antenna array: three masts with glowing tips.
    for x, h in ((-0.32, 2.15), (0, 2.45), (0.32, 2.15)):
        rod(k, (x, 1.3, 1.08), (x, 1.3, h), 0.025, 'Carbon')
        ball(k, 0.07, (x, 1.3, h), 'Glow')
    driver(k, (0, 0.1, 1.15))
    wheels(k, -1.0, 1.05, 0.3, 0.24, 1.7, 1.06, style='buggy')
    return k


# ------------------------------------------------------------------ SATELLITE
def satellite():
    k = root('SATELLITE')
    box(k, (2.2, 3.6, 0.14), (0, 0, 0.4), 'Carbon', 0.03)
    hull(k, 3.4, 2.1, 1.9, (0.42, 1.15), (0.42, 0.85), (0, 0, 0), 'Paint', 0.16)
    hull(k, 1.3, 1.5, 1.4, (1.1, 1.65), (1.1, 1.5), (0, -0.35, 0), 'Paint', 0.12)
    box(k, (1.3, 0.05, 0.36), (0, -1.0, 1.32), 'Visor', 0.02, rot=(-0.35, 0, 0))
    box(k, (1.3, 1.0, 0.04), (0, -0.35, 1.68), 'Solar', 0.01)
    box(k, (2.0, 0.15, 0.3), (0, -1.78, 0.6), 'Metal', 0.05)
    for s in (-1, 1):
        for y in (-1.15, 1.15):
            box(k, (0.72, 1.25, 0.32), (s * 1.18, y, 0.98), 'Paint', 0.12)
        box(k, (0.04, 3.0, 0.06), (s * 1.07, 0, 0.75), 'Glow', 0)
        box(k, (0.3, 0.05, 0.14), (s * 0.7, -1.71, 0.88), 'Lamp', 0)
    # Dish on a mast, tilted up and back, with a glowing feed horn.
    cyl(k, 0.08, 0.5, (0, 1.05, 1.4), 'Metal')
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.75, segments=32, ring_count=16, location=(0, 0, 0))
    dish = active()
    bm = bmesh.new()
    bm.from_mesh(dish.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > 0.02], context='VERTS')
    bm.to_mesh(dish.data)
    bm.free()
    dish.scale = (1, 1, 0.38)
    bpy.ops.object.transform_apply(scale=True)
    dish.modifiers.new('Solid', 'SOLIDIFY').thickness = 0.04
    finish(dish, 'Metal', k, smooth=True)
    dish.location = (0, 1.2, 1.85)
    dish.rotation_euler = (-0.55, 0, 0)
    rod(k, (0, 1.2, 1.62), (0, 1.48, 2.3), 0.025, 'Metal')
    ball(k, 0.09, (0, 1.48, 2.3), 'Glow')
    wheels(k, -1.15, 1.15, 0.34, 0.22, 1.6, 1.15, style='dish')
    return k


# ------------------------------------------------------------------ RADIO
def radio():
    k = root('RADIO')
    box(k, (1.8, 3.6, 0.12), (0, 0, 0.36), 'Carbon', 0.03)
    hull(k, 3.6, 1.5, 1.2, (0.38, 0.95), (0.38, 0.8), (0, 0, 0), 'Paint', 0.18)
    # Rounded fenders over each wheel, like an old roadster.
    for s in (-1, 1):
        for y in (-1.15, 1.2):
            ball(k, 0.62, (s * 1.0, y, 0.72), 'Paint', scale=(0.75, 1.25, 0.6))
        rod(k, (s * 0.86, -0.6, 0.45), (s * 0.86, 0.8, 0.45), 0.07, 'Metal')
        box(k, (0.05, 2.4, 0.05), (s * 0.76, 0.1, 0.9), 'Glow', 0)
        cyl(k, 0.16, 0.08, (s * 0.6, -1.8, 0.84), 'Lamp', rot=(math.pi / 2, 0, 0))
    # Chrome grille.
    box(k, (1.0, 0.08, 0.42), (0, -1.82, 0.66), 'Metal', 0.03)
    for x in (-0.36, -0.12, 0.12, 0.36):
        box(k, (0.05, 0.1, 0.36), (x, -1.86, 0.66), 'Carbon', 0)
    box(k, (1.2, 0.05, 0.38), (0, -0.3, 1.12), 'Visor', 0.02, rot=(-0.4, 0, 0))
    driver(k, (0, 0.35, 1.2))
    # Speaker dial on the tail and a tall whip antenna.
    cyl(k, 0.36, 0.1, (0, 1.82, 0.82), 'Metal', rot=(math.pi / 2, 0, 0))
    cyl(k, 0.24, 0.13, (0, 1.84, 0.82), 'Glow', rot=(math.pi / 2, 0, 0))
    rod(k, (0.55, 1.4, 0.95), (0.7, 1.75, 3.1), 0.03, 'Metal')
    ball(k, 0.09, (0.7, 1.75, 3.1), 'Glow')
    wheels(k, -1.15, 1.2, 0.3, 0.2, 1.4, 1.0, style='whitewall')
    return k


# ------------------------------------------------------------------ LASER
def laser():
    k = root('LASER')
    box(k, (1.9, 3.7, 0.1), (0, 0, 0.3), 'Carbon', 0.02)
    hull(k, 3.8, 1.6, 0.3, (0.32, 0.8), (0.32, 0.42), (0, -0.1, 0), 'Paint', 0.06)
    ball(k, 0.55, (0, 0.25, 0.86), 'Visor', scale=(0.8, 1.6, 0.55))
    for s in (-1, 1):
        hull(k, 1.6, 0.12, 0.08, (0.6, 1.55), (0.6, 0.75), (s * 0.95, 1.05, 0), 'Paint', 0.03)
        box(k, (0.04, 3.2, 0.04), (s * 0.82, -0.1, 0.62), 'Glow', 0)
        for y in (-1.2, 1.15):
            hull(k, 1.25, 0.5, 0.42, (0.3, 0.78), (0.3, 0.6), (s * 1.08, y, 0), 'Carbon', 0.1)
        cyl(k, 0.18, 0.3, (s * 0.45, 1.95, 0.6), 'Metal', rot=(math.pi / 2, 0, 0))
        cyl(k, 0.12, 0.32, (s * 0.45, 1.96, 0.6), 'Glow', rot=(math.pi / 2, 0, 0))
    # The emitter: a glowing lens on the nose with a beam line along the spine.
    ball(k, 0.15, (0, -2.02, 0.44), 'Glow')
    box(k, (0.05, 1.6, 0.03), (0, -1.15, 0.58), 'Glow', 0, rot=(math.atan2(0.3, 1.9), 0, 0))
    wheels(k, -1.2, 1.15, 0.26, 0.15, 1.3, 1.06, style='turbine')
    return k


def export(k, path):
    bpy.ops.object.select_all(action='DESELECT')
    k.select_set(True)
    for c in k.children_recursive:
        c.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True)
    print('exported', path, os.path.getsize(path), 'bytes')


os.makedirs(OUT, exist_ok=True)
karts = []
for name, build in (('fiber', fiber), ('5g', five_g), ('satellite', satellite), ('radio', radio), ('laser', laser)):
    k = build()
    if ARCHES:
        carve_arches(k)
    karts.append((name, k))
for name, k in karts:
    export(k, os.path.join(OUT, f'kart-{name}.glb'))

if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    colors = [(0.0, 0.85, 1.0), (1.0, 0.45, 0.05), (0.55, 1.0, 0.1), (1.0, 0.15, 0.6), (1.0, 0.85, 0.1)]
    # One paint colour per kart for the preview only.
    for (name, k), col in zip(karts, colors):
        paint = M['Paint'].copy()
        next(n for n in paint.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'].default_value = (*col, 1)
        for c in k.children_recursive:
            if c.type == 'MESH':
                for slot in c.material_slots:
                    if slot.material == M['Paint']:
                        slot.material = paint
    for (name, k), x in zip(karts, (-6.6, -3.3, 0, 3.3, 6.6)):
        k.location.x = x
    scene = bpy.context.scene
    try:
        scene.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        scene.render.engine = 'BLENDER_WORKBENCH'
    scene.render.resolution_x, scene.render.resolution_y = 1400, 600
    world = bpy.data.worlds.new('W')
    world.color = (0.05, 0.06, 0.08)
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    finish(active(), 'Carbon', None)
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    scene.collection.objects.link(cam)
    cam.data.lens = 38
    scene.camera = cam
    for loc, power in (((5, -5, 8), 1500), ((-6, -3, 5), 700), ((0, 6, 6), 900)):
        light = bpy.data.objects.new('L', bpy.data.lights.new('L', 'AREA'))
        light.data.energy = power
        light.data.size = 5
        light.location = loc
        light.rotation_euler = (0, 0, 0)
        scene.collection.objects.link(light)
        direction = light.location.copy()
        light.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
    # Front three-quarter, then the chase-camera view from behind.
    for view, loc, rot in (('front', (11, -17, 7), (70, 0, 33)), ('back', (-10, 17.5, 7), (70, 0, 209))):
        cam.location = loc
        cam.rotation_euler = tuple(math.radians(a) for a in rot)
        scene.render.filepath = os.path.join(PREVIEW, f'karts-{view}.png')
        bpy.ops.render.render(write_still=True)
        print('preview', scene.render.filepath, scene.render.engine)
