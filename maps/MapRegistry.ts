import * as THREE from 'three';
import { HideoutElectronicsSystem } from '../hideout/HideoutElectronicsSystem';
import { BUNKER_OBJEKT_47_MAP } from './BunkerObjekt47Map';
import { KINO_THEATER_MAP } from './KinoTheaterMap';
import { KORSAKOV_SUBSTATION_MAP } from './KorsakovSubstationMap';
import { PRIPYAT_BLOCK_MAP } from './PripyatBlockMap';
import { STALINGRAD_DEPOT_MAP } from './StalingradDepotMap';
import { TIMBERLINE_COMPOUND_MAP } from './TimberlineCompoundMap';
import { VOLGA_CORRIDOR_MAP } from './VolgaCorridorMap';
import { BuiltMapInstance, IMapDefinition, MapBuildOptions } from './types';

function attachUniversalMapElectronics(built: BuiltMapInstance): BuiltMapInstance {
  if (built.electronicsSystem) return built;

  const electronics = new HideoutElectronicsSystem(built.sceneGroup);
  built.sceneGroup.updateMatrixWorld(true);

  const tmpBox = new THREE.Box3();
  const tmpCenter = new THREE.Vector3();
  const tmpSize = new THREE.Vector3();

  // 1. Register interactive electronic stations (power switches, perk machines, mystery crates)
  for (let i = 0; i < built.interactables.length; i++) {
    const it = built.interactables[i];
    if (
      it.kind !== 'power_switch' &&
      it.kind !== 'perk_machine' &&
      it.kind !== 'mystery_crate'
    ) {
      continue;
    }

    const pos = new THREE.Vector3(it.position[0], it.position[1], it.position[2]);
    const hitMeshes: THREE.Object3D[] = [];
    const emissiveMeshes: THREE.Mesh[] = [];
    const linkedLights: Array<{ light: THREE.Light; dropFraction: number }> = [];

    built.sceneGroup.traverse((obj) => {
      if (obj instanceof THREE.PointLight || obj instanceof THREE.SpotLight) {
        obj.getWorldPosition(tmpCenter);
        if (tmpCenter.distanceToSquared(pos) <= 2.4 * 2.4) {
          linkedLights.push({ light: obj, dropFraction: 1.0 });
        }
        return;
      }
      if (!(obj instanceof THREE.Mesh) || obj instanceof THREE.InstancedMesh) return;
      if (obj.userData?.destructibleDoorId || obj.userData?.hideoutElectronicId) return;
      tmpBox.setFromObject(obj);
      if (tmpBox.isEmpty()) return;
      tmpBox.getSize(tmpSize);
      const maxDim = Math.max(tmpSize.x, tmpSize.y, tmpSize.z);
      if (maxDim < 0.05 || maxDim > 3.2) return;
      tmpBox.getCenter(tmpCenter);
      if (tmpCenter.distanceToSquared(pos) <= 1.45 * 1.45) {
        hitMeshes.push(obj);
        const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (
          mat instanceof THREE.MeshStandardMaterial &&
          mat.emissive &&
          mat.emissiveIntensity > 0.12
        ) {
          emissiveMeshes.push(obj);
        }
      }
    });

    if (hitMeshes.length > 0) {
      const sparkOrigin = new THREE.Vector3(pos.x, pos.y + 0.25, pos.z);
      const repairAnchor = new THREE.Vector3(pos.x, Math.min(1.45, Math.max(0.95, pos.y)), pos.z);
      electronics.registerNode(
        {
          id: `interact_${it.id}`,
          label: it.label || (it.kind === 'power_switch' ? 'Power Switch' : 'Machine'),
          hitMeshes,
          sparkOrigin,
          repairAnchor,
          emissiveMeshes,
          linkedLights,
          isLightFixture: false,
          interactiveLinkId: it.id,
          repairable: true,
          repairDurationSec: it.kind === 'power_switch' ? 2.1 : 2.2,
        },
        built.raycastMeshes,
      );
    }
  }

  // 2. Auto-discover and register all map light fixtures, streetlamps, floodlights, screens, monitors, beacons & consoles
  electronics.autoRegisterSceneElectronics(built.sceneGroup, {
    raycastMeshes: built.raycastMeshes,
    nightLights: built.envBindings?.nightLights,
    idPrefix: `${built.id}_elec`,
    lightMatchRadiusM: 4.0,
  });

  built.electronicsSystem = electronics;

  const origDispose = built.dispose;
  built.dispose = () => {
    electronics.dispose();
    origDispose();
  };

  return built;
}

function withUniversalElectronics(def: IMapDefinition): IMapDefinition {
  return {
    ...def,
    build: (scene, renderer, isSoftwareGl, graphicsQuality, options?: MapBuildOptions) =>
      attachUniversalMapElectronics(def.build(scene, renderer, isSoftwareGl, graphicsQuality, options)),
  };
}

export const BATTLE_MAPS: readonly IMapDefinition[] = [
  withUniversalElectronics(PRIPYAT_BLOCK_MAP),
  withUniversalElectronics(TIMBERLINE_COMPOUND_MAP),
  withUniversalElectronics(KORSAKOV_SUBSTATION_MAP),
  withUniversalElectronics(VOLGA_CORRIDOR_MAP),
];

/**
 * Extensible Infection Map Registry.
 * All three Infection maps (Kino Theater, Stalingrad Rail Depot, Bunker Objekt-47) are playable.
 */
export const ZOMBIE_MAPS: readonly IMapDefinition[] = [
  withUniversalElectronics(KINO_THEATER_MAP),
  withUniversalElectronics(STALINGRAD_DEPOT_MAP),
  withUniversalElectronics(BUNKER_OBJEKT_47_MAP),
];

export const ALL_MAPS: readonly IMapDefinition[] = [...BATTLE_MAPS, ...ZOMBIE_MAPS];

export function getMapDefinitionById(mapId: string): IMapDefinition | undefined {
  return ALL_MAPS.find((m) => m.id === mapId);
}
