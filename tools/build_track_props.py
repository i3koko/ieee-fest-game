"""Builds Jam Kart GP's trackside props in Blender and exports them as GLB.

Headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/build_track_props.py -- public/models/gp
In an open Blender (builds in a new "JamKartProps" scene, leaving yours alone):
  OUT_DIR = '/abs/path/public/models/gp'; exec(open('/abs/path/tools/build_track_props.py').read())

Props face -Y in Blender (+Z in three.js). Mesh names matter to the game:
"Banner*" planes get sponsor artwork, "Light_1".."Light_5" are the start lights.
"""
import math
import os
import sys

import bmesh
import bpy

if 'OUT_DIR' not in globals():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    OUT_DIR = args[0] if args else 'public/models/gp'

if bpy.app.background:
    bpy.ops.wm.read_factory_settings(use_empty=True)
else:
    scene = bpy.data.scenes.get('JamKartProps') or bpy.data.scenes.new('JamKartProps')
    bpy.context.window.scene = scene
    for o in list(scene.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def material(name, color, metal=0.0, rough=0.6, emit=None, strength=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
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
    'Concrete': material('Concrete', (0.55, 0.55, 0.53), rough=0.9),
    'Steel': material('Steel', (0.6, 0.62, 0.66), metal=0.9, rough=0.35),
    'DarkSteel': material('DarkSteel', (0.12, 0.13, 0.15), metal=0.7, rough=0.4),
    'Roof': material('Roof', (0.85, 0.86, 0.88), metal=0.3, rough=0.4),
    'SeatBlue': material('SeatBlue', (0.02, 0.25, 0.6), rough=0.5),
    'SeatWhite': material('SeatWhite', (0.85, 0.85, 0.85), rough=0.5),
    'Glass': material('Glass', (0.08, 0.14, 0.2), metal=0.6, rough=0.05),
    'Garage': material('Garage', (0.03, 0.03, 0.035), rough=0.8),
    'Shutter': material('Shutter', (0.7, 0.72, 0.75), metal=0.5, rough=0.4),
    'Red': material('Red', (0.75, 0.04, 0.04), rough=0.5),
    'White': material('White', (0.92, 0.92, 0.92), rough=0.5),
    'Lamp': material('Lamp', (0.05, 0.0, 0.0), emit=(1, 0.05, 0.02), strength=0.0),
    'Banner': material('Banner', (1, 1, 1), rough=0.6),
    'Dish': material('Dish', (0.9, 0.9, 0.92), metal=0.2, rough=0.3),
    'Black': material('Black', (0.02, 0.02, 0.02), rough=0.6),
}


def finish(o, mat, parent, bevel=0.0, smooth=False):
    if mat:
        o.data.materials.append(M[mat])
    if bevel:
        mod = o.modifiers.new('Bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = 'ANGLE'
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = True
    o.parent = parent
    return o


def active():
    return bpy.context.view_layer.objects.active


def box(parent, size, loc, mat, bevel=0.0, rot=(0, 0, 0), name='Box'):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = active()
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, mat, parent, bevel)


def cyl(parent, r, depth, loc, mat, rot=(0, 0, 0), verts=16, name='Cyl'):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, vertices=verts, location=loc, rotation=rot)
    o = active()
    o.name = name
    return finish(o, mat, parent, smooth=True)


def rod(parent, a, b, r, mat, name='Rod'):
    from mathutils import Vector
    va, vb = Vector(a), Vector(b)
    d = vb - va
    o = cyl(parent, r, d.length, (va + vb) / 2, mat, verts=8, name=name)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d)
    return o


def plane(parent, w, h, loc, mat, name, facing=-1):
    """Upright plane facing -Y (facing=-1) or +Y (facing=1)."""
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=(math.pi / 2, 0, 0 if facing < 0 else math.pi))
    o = active()
    o.name = name
    o.scale = (w, h, 1)
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, mat, parent)


def root(name):
    o = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(o)
    return o


def truss(parent, a, b, height, mat, r=0.06, bays=8):
    """A flat Warren truss from a to b (both on the bottom chord)."""
    ax, ay, az = a
    bx, by, bz = b
    rod(parent, a, b, r * 1.4, mat)
    rod(parent, (ax, ay, az + height), (bx, by, bz + height), r * 1.4, mat)
    for k in range(bays):
        t0, t1 = k / bays, (k + 1) / bays
        p0 = (ax + (bx - ax) * t0, ay + (by - ay) * t0, az + (bz - az) * t0)
        p1 = (ax + (bx - ax) * t1, ay + (by - ay) * t1, az + (bz - az) * t1 + height)
        if k % 2:
            p0, p1 = (p0[0], p0[1], p0[2] + height), (p1[0], p1[1], p1[2] - height)
        rod(parent, p0, p1, r, mat)


# ------------------------------------------------------------------ props

def grandstand():
    k = root('Grandstand')
    L = 24
    # Eight stepped tiers rising away from the track, alternating seat colours.
    for t in range(8):
        y = -4.5 + 0.55 + t * 1.1
        z = 0.5 + t * 0.55
        box(k, (L, 1.1, 0.2), (0, y, z - 0.1), 'Concrete')
        box(k, (L - 0.4, 0.45, 0.35), (0, y + 0.1, z + 0.15), 'SeatBlue' if t % 3 else 'SeatWhite')
    box(k, (L, 9, 0.5), (0, 0, 0.25), 'Concrete')
    box(k, (L, 0.4, 6), (0, 4.6, 3), 'Concrete')
    for s in (-1, 1):
        box(k, (0.4, 9.4, 6), (s * L / 2, 0, 3), 'Concrete')
    # Cantilever roof on slim columns.
    for x in (-L / 2 + 1, -L / 4, 0, L / 4, L / 2 - 1):
        rod(k, (x, 4.4, 0), (x, 4.4, 8.2), 0.14, 'Steel')
        rod(k, (x, 4.4, 8.2), (x, -4.6, 7.6), 0.1, 'Steel')
    box(k, (L + 1, 10.4, 0.25), (0, -0.2, 8), 'Roof', rot=(math.radians(-3.5), 0, 0))
    plane(k, L, 1.4, (0, -5.45, 7.3), 'Banner', 'Banner')
    box(k, (L, 0.06, 1.0), (0, -4.7, 0.9), 'White')
    return k


def pit_building():
    k = root('PitBuilding')
    L, D = 60, 12
    box(k, (L, D, 0.4), (0, 0, 0.2), 'Concrete')
    box(k, (L, D, 4.2), (0, 0, 2.5), 'Concrete')
    # Garage bays with lit interiors and half-open shutters.
    for g in range(10):
        x = -L / 2 + 3 + g * (L - 6) / 9
        box(k, (4.6, 0.6, 3.4), (x, -D / 2 + 0.25, 2.1), 'Garage')
        box(k, (4.7, 0.2, 1.2), (x, -D / 2 - 0.05, 3.3), 'Shutter')
    # Glass-fronted upper floor and roof terrace.
    box(k, (L, D - 1.5, 3.2), (0, 0.6, 6.2), 'Glass')
    box(k, (L + 0.4, D + 0.6, 0.4), (0, 0, 7.9), 'Roof')
    for x in range(-29, 30, 4):
        rod(k, (x, -D / 2 - 0.2, 8.1), (x, -D / 2 - 0.2, 9.1), 0.04, 'Steel')
    rod(k, (-L / 2, -D / 2 - 0.2, 9.1), (L / 2, -D / 2 - 0.2, 9.1), 0.05, 'Steel')
    plane(k, L - 4, 1.6, (0, -D / 2 - 0.36, 5.0), 'Banner', 'Banner')
    # Pit wall with a gantry for the teams.
    box(k, (L, 0.6, 1.2), (0, -D / 2 - 6, 0.6), 'White')
    return k


def start_gantry():
    k = root('StartGantry')
    span = 22
    for s in (-1, 1):
        box(k, (0.8, 0.8, 7.5), (s * span / 2, 0, 3.75), 'DarkSteel')
    box(k, (span + 0.8, 0.9, 1.4), (0, 0, 7.3), 'DarkSteel')
    plane(k, span - 2, 1.1, (0, -0.47, 7.3), 'Banner', 'Banner')
    # Five light pods hang under the beam, two red lamps each.
    for n in range(5):
        x = -4 + n * 2
        box(k, (1.2, 0.6, 2.2), (x, 0, 5.4), 'Black')
        for z in (5.95, 4.95):
            cyl(k, 0.34, 0.12, (x, -0.33, z), 'Lamp', rot=(math.pi / 2, 0, 0), verts=20, name=f'Light_{n + 1}')
    return k


def bridge():
    k = root('Bridge')
    span = 30
    deck = 7.2
    for s in (-1, 1):
        # Stair towers at each end.
        box(k, (3.2, 3.2, deck + 1.0), (s * (span / 2 + 1.6), 0, (deck + 1.0) / 2), 'Concrete')
    box(k, (span, 2.6, 0.4), (0, 0, deck), 'DarkSteel')
    for y in (-1.25, 1.25):
        truss(k, (-span / 2, y, deck + 0.2), (span / 2, y, deck + 0.2), 1.8, 'Steel', bays=10)
    plane(k, span - 2, 1.5, (0, -1.4, deck - 1.0), 'Banner', 'Banner')
    plane(k, span - 2, 1.5, (0, 1.4, deck - 1.0), 'Banner', 'BannerBack', facing=1)
    return k


def camera_tower():
    k = root('CameraTower')
    h = 6
    for x, y in ((-1.2, -1.2), (1.2, -1.2), (1.2, 1.2), (-1.2, 1.2)):
        rod(k, (x, y, 0), (x, y, h), 0.06, 'Steel')
    for z in range(1, h, 1):
        rod(k, (-1.2, -1.2, z - 1), (1.2, -1.2, z), 0.03, 'Steel')
        rod(k, (1.2, 1.2, z - 1), (-1.2, 1.2, z), 0.03, 'Steel')
        rod(k, (-1.2, -1.2, z), (-1.2, 1.2, z - 1), 0.03, 'Steel')
        rod(k, (1.2, -1.2, z), (1.2, 1.2, z - 1), 0.03, 'Steel')
    box(k, (3, 3, 0.15), (0, 0, h), 'DarkSteel')
    for s in (-1, 1):
        rod(k, (s * 1.45, -1.45, h), (s * 1.45, -1.45, h + 1), 0.03, 'Steel')
    # Broadcast camera on a tripod, and its operator.
    box(k, (0.5, 1.1, 0.55), (0, -0.4, h + 1.6), 'Black')
    cyl(k, 0.2, 0.5, (0, -1.1, h + 1.6), 'DarkSteel', rot=(math.pi / 2, 0, 0))
    rod(k, (0, -0.4, h), (0, -0.4, h + 1.3), 0.05, 'Steel')
    box(k, (0.6, 0.4, 1.0), (0, 0.5, h + 0.9), 'Red')
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.22, location=(0, 0.5, h + 1.62))
    finish(active(), 'White', k, smooth=True)
    # A parasol for the operator.
    bpy.ops.mesh.primitive_cone_add(radius1=1.4, depth=0.5, location=(0, 0.2, h + 2.7))
    finish(active(), 'White', k, smooth=True)
    rod(k, (0, 0.2, h), (0, 0.2, h + 2.5), 0.03, 'Steel')
    return k


def dish():
    k = root('SatelliteDish')
    box(k, (4, 4, 1.2), (0, 0, 0.6), 'Concrete')
    cyl(k, 0.5, 4, (0, 0, 3.0), 'Steel')
    bpy.ops.mesh.primitive_uv_sphere_add(radius=4, segments=40, ring_count=20, location=(0, 0, 0))
    d = active()
    bm = bmesh.new()
    bm.from_mesh(d.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > 0.02], context='VERTS')
    bm.to_mesh(d.data)
    bm.free()
    d.scale = (1, 1, 0.4)
    bpy.ops.object.transform_apply(scale=True)
    d.modifiers.new('Solid', 'SOLIDIFY').thickness = 0.12
    finish(d, 'Dish', k, smooth=True)
    d.location = (0, 0.6, 5.4)
    d.rotation_euler = (math.radians(-55), 0, 0)
    # Feed horn held at the focus by three struts.
    from mathutils import Euler, Vector
    rot = Euler((math.radians(-55), 0, 0))
    focus = Vector((0, 0.6, 5.4)) + (Vector((0, 0, 3.2)) @ rot.to_matrix().inverted())
    for a in range(3):
        ang = a * 2 * math.pi / 3
        rim = Vector((math.cos(ang) * 3.6, math.sin(ang) * 3.6, 1.4))
        rim.rotate(rot)
        rod(k, Vector((0, 0.6, 5.4)) + rim, focus, 0.06, 'Steel')
    bpy.ops.mesh.primitive_cylinder_add(radius=0.35, depth=0.8, location=focus)
    finish(active(), 'DarkSteel', k, smooth=True)
    return k


def export(k, path):
    bpy.ops.object.select_all(action='DESELECT')
    k.select_set(True)
    for c in k.children_recursive:
        c.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True)
    print('exported', path, os.path.getsize(path), 'bytes')


os.makedirs(OUT_DIR, exist_ok=True)
PROPS = [
    ('grandstand', grandstand()),
    ('pits', pit_building()),
    ('start', start_gantry()),
    ('bridge', bridge()),
    ('camera', camera_tower()),
    ('dish', dish()),
]
for name, k in PROPS:
    export(k, os.path.join(OUT_DIR, f'{name}.glb'))

# Lay them out side by side for a look.
x = 0
for name, k in PROPS:
    k.location.x = x
    x += 70 if name == 'pits' else 40
