import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type MenuBackdropMood = 'home' | 'playground' | 'battle' | 'infection';

interface MenuBackdrop3DProps {
  mood: MenuBackdropMood;
}

interface MoodPalette {
  bg: THREE.Color;
  fog: THREE.Color;
  keyColor: THREE.Color;
  rimColor: THREE.Color;
  keyIntensity: number;
  rimIntensity: number;
  camAngle: number;
  camY: number;
}

const MOOD_PALETTES: Record<MenuBackdropMood, MoodPalette> = {
  home: {
    bg: new THREE.Color(0x0b0d10),
    fog: new THREE.Color(0x0d1014),
    keyColor: new THREE.Color(0xf0c98d),
    rimColor: new THREE.Color(0x527a9c),
    keyIntensity: 2.6,
    rimIntensity: 2.2,
    camAngle: 0.2,
    camY: 2.3,
  },
  playground: {
    bg: new THREE.Color(0x101317),
    fog: new THREE.Color(0x12161b),
    keyColor: new THREE.Color(0xf5c878),
    rimColor: new THREE.Color(0x8ea3b8),
    keyIntensity: 3.1,
    rimIntensity: 1.9,
    camAngle: -0.35,
    camY: 2.6,
  },
  battle: {
    bg: new THREE.Color(0x0a1017),
    fog: new THREE.Color(0x0d151e),
    keyColor: new THREE.Color(0x9dc2e0),
    rimColor: new THREE.Color(0xd97736),
    keyIntensity: 2.8,
    rimIntensity: 2.8,
    camAngle: 0.72,
    camY: 2.1,
  },
  infection: {
    bg: new THREE.Color(0x0b0507),
    fog: new THREE.Color(0x140709),
    keyColor: new THREE.Color(0xc83a3a),
    rimColor: new THREE.Color(0x661a22),
    keyIntensity: 3.4,
    rimIntensity: 3.0,
    camAngle: -0.82,
    camY: 1.95,
  },
};

/**
 * Live 3D tactical brutalist architectural backdrop for the Main Menu.
 * Smoothly damps lighting palette and camera parallax as the user switches between
 * PLAYGROUND, BATTLE, and INFECTION tabs.
 */
export const MenuBackdrop3D: React.FC<MenuBackdrop3DProps> = ({ mood }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const moodRef = useRef<MenuBackdropMood>(mood);

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const width = Math.max(1, el.clientWidth);
    const height = Math.max(1, el.clientHeight);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });

    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const isSoftwareGl = /swiftshader|llvmpipe|software/i.test(glRenderer);

    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const initPal = MOOD_PALETTES[moodRef.current];
    scene.background = initPal.bg.clone();
    const fog = new THREE.FogExp2(initPal.fog.getHex(), 0.055);
    scene.fog = fog;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.35;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 80);

    // Architectural concrete hall using InstancedMesh
    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(res: T): T => {
      disposables.push(res);
      return res;
    };

    const matFloor = track(
      new THREE.MeshStandardMaterial({ color: 0x1b1e23, roughness: 0.72, metalness: 0.12 }),
    );
    const matConcrete = track(
      new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.88, metalness: 0.06 }),
    );
    const matSteel = track(
      new THREE.MeshStandardMaterial({ color: 0x20242a, roughness: 0.45, metalness: 0.72 }),
    );
    const matCrate = track(
      new THREE.MeshStandardMaterial({ color: 0x333730, roughness: 0.84, metalness: 0.08 }),
    );
    const matBeacon = track(
      new THREE.MeshStandardMaterial({
        color: 0xe2c088,
        emissive: 0xe2c088,
        emissiveIntensity: 1.5,
        roughness: 0.25,
      }),
    );

    const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(60, 60)), matFloor);
    floor.rotation.x = -Math.PI * 0.5;
    scene.add(floor);

    const ceiling = new THREE.Mesh(track(new THREE.PlaneGeometry(60, 60)), matConcrete);
    ceiling.rotation.x = Math.PI * 0.5;
    ceiling.position.y = 7.4;
    scene.add(ceiling);

    // Instanced brutalist colonnade pillars (24 pillars = 1 draw call)
    const pillarGeo = track(new THREE.BoxGeometry(0.85, 7.4, 0.85));
    const pillars = new THREE.InstancedMesh(pillarGeo, matConcrete, 24);
    const dummy = new THREE.Object3D();
    let idx = 0;
    for (let z = -22; z <= 14; z += 6) {
      for (const x of [-9.5, -4.5, 4.5, 9.5]) {
        if (idx >= 24) break;
        dummy.position.set(x, 3.7, z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        pillars.setMatrixAt(idx++, dummy.matrix);
      }
    }
    pillars.instanceMatrix.needsUpdate = true;
    pillars.computeBoundingSphere();
    scene.add(pillars);

    // Overhead steel rafters (8 beams = 1 draw call)
    const beamGeo = track(new THREE.BoxGeometry(24, 0.42, 0.48));
    const beams = new THREE.InstancedMesh(beamGeo, matSteel, 8);
    for (let i = 0; i < 8; i++) {
      dummy.position.set(0, 6.8, -22 + i * 5.2);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      beams.setMatrixAt(i, dummy.matrix);
    }
    beams.instanceMatrix.needsUpdate = true;
    beams.computeBoundingSphere();
    scene.add(beams);

    // Foreground tactical staging crates & workbench silhouette
    const crateGeo = track(new THREE.BoxGeometry(1.5, 0.85, 0.95));
    const crates = new THREE.InstancedMesh(crateGeo, matCrate, 6);
    const crateTransforms: Array<[number, number, number, number]> = [
      [2.6, 0.425, -4.8, 0.25],
      [3.8, 0.425, -6.1, -0.18],
      [3.1, 1.275, -5.5, 0.4],
      [-3.4, 0.425, -7.4, 0.6],
      [-2.1, 0.425, -8.3, 0.12],
      [1.2, 0.425, -11.5, -0.32],
    ];
    for (let i = 0; i < crateTransforms.length; i++) {
      const [x, y, z, ry] = crateTransforms[i];
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, ry, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      crates.setMatrixAt(i, dummy.matrix);
    }
    crates.instanceMatrix.needsUpdate = true;
    crates.computeBoundingSphere();
    scene.add(crates);

    // Overhead linear strip fixtures (4 strips = 1 draw call)
    const stripGeo = track(new THREE.BoxGeometry(3.2, 0.08, 0.22));
    const strips = new THREE.InstancedMesh(stripGeo, matBeacon, 4);
    for (let i = 0; i < 4; i++) {
      dummy.position.set(1.5, 6.55, -2 - i * 5.5);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      strips.setMatrixAt(i, dummy.matrix);
    }
    strips.instanceMatrix.needsUpdate = true;
    strips.computeBoundingSphere();
    scene.add(strips);

    // Atmospheric suspended dust motes (InstancedMesh = 1 draw call)
    const MOTE_COUNT = 64;
    const moteGeo = track(new THREE.BoxGeometry(0.03, 0.03, 0.03));
    const moteMat = track(
      new THREE.MeshBasicMaterial({ color: 0xcbd5e1, transparent: true, opacity: 0.36 }),
    );
    const motes = new THREE.InstancedMesh(moteGeo, moteMat, MOTE_COUNT);
    const moteSeeds: Array<{ x: number; y: number; z: number; speed: number; phase: number }> = [];
    for (let i = 0; i < MOTE_COUNT; i++) {
      moteSeeds.push({
        x: (Math.random() - 0.5) * 18,
        y: 0.4 + Math.random() * 5.6,
        z: -18 + Math.random() * 20,
        speed: 0.14 + Math.random() * 0.24,
        phase: Math.random() * Math.PI * 2,
      });
    }
    scene.add(motes);

    // Lighting
    const hemi = new THREE.HemisphereLight(0x8899aa, 0x15181c, 0.55);
    scene.add(hemi);

    const keyLight = new THREE.PointLight(initPal.keyColor, initPal.keyIntensity, 28, 1.5);
    keyLight.position.set(2.8, 5.4, -5.5);
    scene.add(keyLight);

    const rimLight = new THREE.PointLight(initPal.rimColor, initPal.rimIntensity, 32, 1.4);
    rimLight.position.set(-5.5, 3.6, -12.5);
    scene.add(rimLight);

    // Animation loop state
    let disposed = false;
    let rafId = 0;
    let swTimerId: number | null = null;
    let lastMs = performance.now();
    let elapsed = 0;
    let curAngle = initPal.camAngle;
    let curCamY = initPal.camY;
    const curBg = initPal.bg.clone();
    const curFog = initPal.fog.clone();
    const curKey = initPal.keyColor.clone();
    const curRim = initPal.rimColor.clone();
    const lookTarget = new THREE.Vector3(1.6, 1.9, -7.8);

    const onResize = () => {
      if (!el) return;
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    const schedule = () => {
      if (disposed) return;
      if (isSoftwareGl) {
        const ctx = renderer.getContext() as WebGL2RenderingContext;
        const sync =
          typeof ctx.fenceSync === 'function'
            ? ctx.fenceSync(ctx.SYNC_GPU_COMMANDS_COMPLETE, 0)
            : null;
        ctx.flush();
        const poll = () => {
          if (disposed) return;
          if (!sync || ctx.clientWaitSync(sync, 0, 0) !== ctx.TIMEOUT_EXPIRED) {
            if (sync) ctx.deleteSync(sync);
            swTimerId = window.setTimeout(tick, 90);
          } else {
            swTimerId = window.setTimeout(poll, 4);
          }
        };
        swTimerId = window.setTimeout(poll, 4);
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - lastMs) * 0.001));
      lastMs = now;
      elapsed += dt;

      const target = MOOD_PALETTES[moodRef.current];
      const dampT = 1 - Math.exp(-3.4 * dt);

      curBg.lerp(target.bg, dampT);
      curFog.lerp(target.fog, dampT);
      curKey.lerp(target.keyColor, dampT);
      curRim.lerp(target.rimColor, dampT);
      curAngle = THREE.MathUtils.damp(curAngle, target.camAngle, 2.8, dt);
      curCamY = THREE.MathUtils.damp(curCamY, target.camY, 2.8, dt);

      (scene.background as THREE.Color).copy(curBg);
      fog.color.copy(curFog);
      keyLight.color.copy(curKey);
      rimLight.color.copy(curRim);
      keyLight.intensity = THREE.MathUtils.damp(keyLight.intensity, target.keyIntensity, 3.0, dt);
      rimLight.intensity = THREE.MathUtils.damp(rimLight.intensity, target.rimIntensity, 3.0, dt);
      matBeacon.color.copy(curKey);
      matBeacon.emissive.copy(curKey);

      const drift = Math.sin(elapsed * 0.24) * 0.14;
      const radius = 8.8;
      camera.position.set(
        Math.sin(curAngle + drift) * radius + 1.2,
        curCamY + Math.cos(elapsed * 0.35) * 0.12,
        Math.cos(curAngle + drift) * radius - 5.2,
      );
      camera.lookAt(lookTarget);

      // Gentle dust drift
      for (let i = 0; i < MOTE_COUNT; i++) {
        const m = moteSeeds[i];
        const y = ((m.y + elapsed * m.speed * 0.45) % 5.8) + 0.3;
        const x = m.x + Math.sin(elapsed * 0.5 + m.phase) * 0.22;
        dummy.position.set(x, y, m.z);
        dummy.rotation.set(0, elapsed * 0.4 + m.phase, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        motes.setMatrixAt(i, dummy.matrix);
      }
      motes.instanceMatrix.needsUpdate = true;

      renderer.render(scene, camera);
      schedule();
    };

    tick();

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      if (rafId) cancelAnimationFrame(rafId);
      if (swTimerId !== null) clearTimeout(swTimerId);
      envRT.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === el) {
        el.removeChild(renderer.domElement);
      }
    };
  }, []);

  return <div ref={containerRef} className="fixed inset-0 z-0 h-full w-full" />;
};
