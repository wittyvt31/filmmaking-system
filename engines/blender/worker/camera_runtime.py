"""Apply renderer-independent camera samples and cuts to Blender."""

import bpy


def install_cameras(scene, spec, action_fcurves):
    cameras = {}
    for rig in spec["rigs"]:
        optics = rig["optics"]
        sensor = optics["sensor"]
        data = bpy.data.cameras.new(rig["id"])
        data.type = "PERSP"
        data.sensor_fit = sensor["fit"].upper()
        data.sensor_width = sensor["width"]
        data.sensor_height = sensor["height"]
        data.clip_start = optics["clipNear"]
        data.clip_end = optics["clipFar"]
        data.dof.use_dof = optics["depthOfField"]
        data.dof.aperture_fstop = optics["aperture"]
        data.dof.aperture_blades = optics["blades"]
        camera = bpy.data.objects.new(rig["id"], data)
        camera["filmie_camera_id"] = rig["id"]
        camera.rotation_mode = "QUATERNION"
        scene.collection.objects.link(camera)
        cameras[rig["id"]] = camera
        for frame, sample in enumerate(rig["frames"], 1):
            camera.location = sample["position"]
            camera.rotation_quaternion = sample["orientation"]
            data.lens = sample["focalLength"]
            data.dof.focus_distance = sample["focusDistance"]
            camera.keyframe_insert(data_path="location", frame=frame)
            camera.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            data.keyframe_insert(data_path="lens", frame=frame)
            data.keyframe_insert(data_path="dof.focus_distance", frame=frame)
        for owner in (camera, data):
            for curve in action_fcurves(owner.animation_data.action):
                for point in curve.keyframe_points:
                    point.interpolation = "LINEAR"
    for cut in spec["cuts"]:
        marker = scene.timeline_markers.new("Filmie cut | " + cut["cameraId"], frame=cut["startFrame"] + 1)
        marker.camera = cameras[cut["cameraId"]]
    scene.camera = cameras[spec["cuts"][0]["cameraId"]]
