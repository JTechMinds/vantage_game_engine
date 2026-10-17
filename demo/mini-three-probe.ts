import * as THREE from "three";

// Minimal three.js probe mirroring the terrain renderer's exact GL config
// (antialias + ACESFilmicToneMapping + SRGB output + shadows + MeshStandard).
// Purpose: isolate whether the blank terrain is a three-version/renderer-config
// issue under swiftshader or terrain-scene-specific wiring.
const canvas = document.createElement("canvas");
canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh";
document.body.appendChild(canvas);

const gl = new THREE.WebGLRenderer({ canvas, antialias: true });
gl.setPixelRatio(Math.min(2, devicePixelRatio || 1));
gl.outputColorSpace = THREE.SRGBColorSpace;
gl.toneMapping = THREE.ACESFilmicToneMapping;
gl.toneMappingExposure = 1.0;
gl.shadowMap.enabled = true;
gl.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x102030);
const cam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 4000);
cam.position.set(0, 60, 200);
cam.lookAt(0, 0, 0);

// Ground plane using the SAME material class as terrain.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(500, 500),
  new THREE.MeshStandardMaterial({ color: 0x55aa33, roughness: 0.9, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const box = new THREE.Mesh(
  new THREE.BoxGeometry(40, 40, 40),
  new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.6 }),
);
box.position.set(0, 20, 0);
box.castShadow = true;
scene.add(box);

const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(100, 200, 100);
sun.castShadow = true;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x40382a, 0.6));

gl.render(scene, cam);
document.title = "MINI rendered";
