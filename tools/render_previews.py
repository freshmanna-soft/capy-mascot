import bpy
from mathutils import Vector

bpy.ops.wm.open_mainfile(filepath='/Users/javierbritopacheco/codebase/capy-mascot/assets/capybara.blend')
scene = bpy.context.scene
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.world.color = (0.15, 0.12, 0.10)

cam = scene.camera

angles = {
    'front': ((0.0, -8.2, 2.05), (0.0, 0.0, 1.45)),
    'side':  ((-8.2, 0.0, 2.05), (0.0, 0.0, 1.45)),
    'top34': ((-5.5, -5.5, 5.0), (0.0, 0.0, 1.45)),
}
for name, (loc, tgt) in angles.items():
    cam.location = loc
    cam.rotation_euler = (Vector(tgt) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = f'/Users/javierbritopacheco/codebase/capy-mascot/assets/preview_{name}'
    bpy.ops.render.render(write_still=True)
    print(f'RENDERED {name}')
