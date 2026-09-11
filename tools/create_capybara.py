import bpy
import math
from mathutils import Vector

# Reset the default scene.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def material(name, color, roughness=0.82):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


fur = material('Capy fur', (0.43, 0.24, 0.14))
fur_light = material('Capy warm fur', (0.66, 0.40, 0.23))
muzzle_mat = material('Muzzle', (0.70, 0.52, 0.37))
dark = material('Eyes and nose', (0.035, 0.022, 0.017), 0.42)
feet_mat = material('Feet', (0.29, 0.14, 0.085))


def uv(name, location, scale, mat, segments=16, rings=10):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return obj


def cube(name, location, scale, mat, bevel=0.08):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    bevel_mod = obj.modifiers.new('Soft edges', 'BEVEL')
    bevel_mod.width = bevel
    bevel_mod.segments = 2
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=bevel_mod.name)
    return obj

# Body and head: a friendly, broad low-poly silhouette.
uv('Body', (0.0, 0.0, 1.02), (1.28, 0.78, 0.78), fur, 20, 12)
uv('Chest', (0.0, -0.66, 1.15), (0.78, 0.20, 0.52), fur_light, 16, 10)
uv('Head', (0.0, -0.18, 2.00), (0.84, 0.62, 0.70), fur, 20, 12)
uv('Muzzle', (0.0, -0.78, 1.82), (0.56, 0.23, 0.31), muzzle_mat, 16, 10)

# Small rounded ears set high and wide.
for side in (-1, 1):
    uv('Ear', (side * 0.62, -0.12, 2.43), (0.16, 0.12, 0.18), fur, 12, 8)
    uv('Ear inner', (side * 0.62, -0.22, 2.43), (0.08, 0.03, 0.09), muzzle_mat, 12, 8)

# Eyes, nose, and tiny smile.
for side in (-1, 1):
    uv('Eye', (side * 0.31, -0.76, 2.14), (0.095, 0.045, 0.085), dark, 16, 10)
    uv('Brow', (side * 0.31, -0.79, 2.29), (0.13, 0.025, 0.035), dark, 12, 8)
uv('Nose', (0.0, -1.02, 1.82), (0.15, 0.06, 0.09), dark, 12, 8)

# Four simple feet keep the silhouette readable at small app sizes.
for side in (-1, 1):
    for y in (-0.34, 0.36):
        cube('Foot', (side * 0.70, y, 0.46), (0.18, 0.25, 0.12), feet_mat, 0.10)

# A small tail peeks from behind the body.
uv('Tail', (0.0, 0.72, 1.28), (0.18, 0.18, 0.18), fur_light, 12, 8)

# Groundless studio lighting; the app supplies its own transparent stage.
bpy.ops.object.select_all(action='SELECT')
for obj in bpy.context.selected_objects:
    obj.select_set(True)

bpy.ops.object.select_all(action='DESELECT')
for name, location, energy, size in [
    ('Key', (-4.0, -5.0, 6.0), 700, 4.0),
    ('Fill', (4.0, -2.0, 3.5), 350, 3.0),
    ('Rim', (0.0, 3.5, 4.5), 500, 2.5),
]:
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.name = name
    light.data.energy = energy
    light.data.shape = 'DISK'
    light.data.size = size
    direction = Vector((0.0, 0.0, 1.3)) - light.location
    light.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

# Keep a useful camera in the file for manual inspection in Blender.
bpy.ops.object.camera_add(location=(0.0, -8.2, 2.05))
camera = bpy.context.object
camera.data.lens = 58
camera.rotation_euler = (Vector((0.0, 0.0, 1.45)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = camera

scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 512
scene.render.resolution_y = 512
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.world.color = (0.04, 0.025, 0.02)

# Export a portable asset for the Electron app.
output = '/Users/javierbritopacheco/codebase/capy-mascot/assets/capybara.glb'
bpy.ops.wm.save_as_mainfile(filepath='/Users/javierbritopacheco/codebase/capy-mascot/assets/capybara.blend')
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', export_apply=True)
print('CAPYBARA_EXPORTED', output)
