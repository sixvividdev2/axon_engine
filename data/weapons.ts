import { BodycamFireMode, PlatformBuilderStyle } from '../bodycam-sdk/types';
import { CaliberId } from './calibers';

export type WeaponId =
  | 'unarmed'
  | 'pm_9x19'
  | 'aks74u_545'
  | 'ak74u_545'
  | 'm4_556'
  | 'akm_762'
  | 'mp133_12ga'
  | 'tactical_knife'
  | 'crowbar'
  | 'rgd5_frag'
  | 'throw_bolt';

export type FireMode = BodycamFireMode;

export type HoldClass =
  | 'unarmed'
  | 'pistol'
  | 'rifle'
  | 'shotgun'
  | 'melee_1h'
  | 'melee_2h'
  | 'throwable';

export type EquipSlotKind = 'unarmed' | 'primary' | 'sidearm' | 'melee' | 'throwable';

export interface WeaponHandSocket {
  position: [number, number, number];
  /** Euler rotation in radians (XYZ) for hand alignment on the weapon */
  rotation: [number, number, number];
  /** Finger curl factor (0 = open palm, 1 = tight grip) */
  gripCurl?: number;
}

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  itemId: string | null;
  caliberId: CaliberId | null;
  holdClass: HoldClass;
  slotKind: EquipSlotKind;
  fireMode: FireMode;
  rpm: number;
  barrelLengthM: number;
  /** Local hip/ready position relative to right shoulder anchor */
  hipOffset: [number, number, number];
  /** Local ADS position relative to camera sight line */
  adsOffset: [number, number, number];
  /** Local sprint low-ready position relative to right shoulder anchor */
  lowReadyOffset: [number, number, number];
  lowReadyRotation: [number, number, number];
  /** Local right-hand IK socket on the weapon model */
  rightHandSocket: WeaponHandSocket;
  /** Optional local left-hand IK socket for two-handed support/forend */
  leftHandSocket?: WeaponHandSocket;
  /** Muzzle tip offset in weapon local space (+Z is backward, -Z is forward) */
  muzzleOffset: [number, number, number];
  /** Vertical recoil pitch kick (radians) */
  recoilPitchRad: number;
  /** Horizontal recoil yaw jitter (radians) */
  recoilYawRad: number;
  /** Weapon backward kick (meters) */
  kickBackM: number;
  /** Compatible magazine item id */
  compatibleMagId: string | null;
  /** Compatible suppressor item id */
  compatibleSuppressorId: 'suppressor_9mm' | 'suppressor_rifle' | null;
  /** Visual blueprint style for procedural model */
  visualStyle: PlatformBuilderStyle;
  reloadDurationSec: number;
  magCheckDurationSec: number;
  /** Melee properties */
  meleeEnergyJ?: number;
  meleeRangeM?: number;
  meleeSwingDurationSec?: number;
  /** Throwable properties */
  fuseDurationSec?: number;
  throwVelocityMps?: number;
  consumableOnThrow?: boolean;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  unarmed: {
    id: 'unarmed',
    name: 'Unarmed',
    itemId: null,
    caliberId: null,
    holdClass: 'unarmed',
    slotKind: 'unarmed',
    fireMode: 'melee',
    rpm: 0,
    barrelLengthM: 0.25,
    hipOffset: [-0.08, 0.05, -0.22],
    adsOffset: [0, -0.05, -0.24],
    lowReadyOffset: [-0.09, -0.03, -0.18],
    lowReadyRotation: [-0.35, 0.1, 0],
    rightHandSocket: {
      position: [-0.02, 0.02, -0.02],
      rotation: [0.22, 0.18, -1.05],
      gripCurl: 0.90,
    },
    leftHandSocket: {
      position: [-0.24, 0.01, -0.05],
      rotation: [0.24, -0.22, 1.05],
      gripCurl: 0.90,
    },
    muzzleOffset: [0, 0, -0.25],
    recoilPitchRad: 0,
    recoilYawRad: 0,
    kickBackM: 0,
    compatibleMagId: null,
    compatibleSuppressorId: null,
    visualStyle: 'unarmed',
    reloadDurationSec: 0,
    magCheckDurationSec: 0,
    meleeEnergyJ: 95,
    meleeRangeM: 1.55,
    meleeSwingDurationSec: 0.44,
  },
  pm_9x19: {
    id: 'pm_9x19',
    name: 'MP-443 Grach 9x19',
    itemId: 'weapon_pm_9x19',
    caliberId: '9x19_fmj',
    holdClass: 'pistol',
    slotKind: 'sidearm',
    fireMode: 'semi',
    rpm: 380,
    barrelLengthM: 0.42,
    hipOffset: [-0.04, 0.01, -0.36],
    adsOffset: [0, -0.050, -0.40],
    lowReadyOffset: [-0.04, -0.05, -0.28],
    lowReadyRotation: [-0.62, 0.28, 0.12],
    rightHandSocket: {
      position: [0.023, -0.036, 0.042],
      rotation: [-0.08, 0.0, -1.55],
      gripCurl: 0.96,
    },
    leftHandSocket: {
      position: [-0.025, -0.040, 0.034],
      rotation: [-0.10, -0.32, 1.52],
      gripCurl: 0.92,
    },
    muzzleOffset: [0, 0.028, -0.21],
    recoilPitchRad: 0.042,
    recoilYawRad: 0.016,
    kickBackM: 0.032,
    compatibleMagId: 'mag_9x19_15',
    compatibleSuppressorId: 'suppressor_9mm',
    visualStyle: 'pistol',
    reloadDurationSec: 1.45,
    magCheckDurationSec: 1.05,
    meleeEnergyJ: 110,
    meleeRangeM: 1.55,
    meleeSwingDurationSec: 0.46,
  },
  ak74u_545: {
    id: 'ak74u_545',
    name: 'AKS-74U 5.45x39',
    itemId: 'weapon_ak74u_545',
    caliberId: '545x39_7n6',
    holdClass: 'rifle',
    slotKind: 'primary',
    fireMode: 'auto',
    rpm: 650,
    barrelLengthM: 0.68,
    hipOffset: [-0.08, -0.025, -0.28],
    adsOffset: [0, -0.054, -0.30],
    lowReadyOffset: [-0.10, -0.06, -0.25],
    lowReadyRotation: [-0.46, 0.56, 0.20],
    rightHandSocket: {
      position: [0.024, -0.044, 0.026],
      rotation: [-0.10, 0.0, -1.55],
      gripCurl: 0.96,
    },
    leftHandSocket: {
      position: [-0.036, -0.030, -0.205],
      rotation: [0.06, -0.42, 2.22],
      gripCurl: 0.90,
    },
    muzzleOffset: [0, 0.024, -0.42],
    recoilPitchRad: 0.034,
    recoilYawRad: 0.018,
    kickBackM: 0.028,
    compatibleMagId: 'mag_545_30',
    compatibleSuppressorId: 'suppressor_rifle',
    visualStyle: 'carbine_ak',
    reloadDurationSec: 2.05,
    magCheckDurationSec: 1.15,
    meleeEnergyJ: 145,
    meleeRangeM: 1.72,
    meleeSwingDurationSec: 0.52,
  },
  aks74u_545: {
    id: 'aks74u_545',
    name: 'AKS-74U 5.45x39',
    itemId: 'weapon_aks74u_545',
    caliberId: '545x39_7n6',
    holdClass: 'rifle',
    slotKind: 'primary',
    fireMode: 'auto',
    rpm: 650,
    barrelLengthM: 0.68,
    hipOffset: [-0.08, -0.025, -0.28],
    adsOffset: [0, -0.054, -0.30],
    lowReadyOffset: [-0.10, -0.06, -0.25],
    lowReadyRotation: [-0.46, 0.56, 0.20],
    rightHandSocket: {
      position: [0.024, -0.044, 0.026],
      rotation: [-0.10, 0.0, -1.55],
      gripCurl: 0.96,
    },
    leftHandSocket: {
      position: [-0.036, -0.030, -0.205],
      rotation: [0.06, -0.42, 2.22],
      gripCurl: 0.90,
    },
    muzzleOffset: [0, 0.024, -0.42],
    recoilPitchRad: 0.034,
    recoilYawRad: 0.018,
    kickBackM: 0.028,
    compatibleMagId: 'mag_545_30',
    compatibleSuppressorId: 'suppressor_rifle',
    visualStyle: 'carbine_ak',
    reloadDurationSec: 2.05,
    magCheckDurationSec: 1.15,
    meleeEnergyJ: 145,
    meleeRangeM: 1.72,
    meleeSwingDurationSec: 0.52,
  },
  m4_556: {
    id: 'm4_556',
    name: 'M4A1 5.56x45',
    itemId: 'weapon_m4_556',
    caliberId: '556x45_m855',
    holdClass: 'rifle',
    slotKind: 'primary',
    fireMode: 'auto',
    rpm: 750,
    barrelLengthM: 0.74,
    hipOffset: [-0.08, -0.025, -0.28],
    adsOffset: [0, -0.055, -0.31],
    lowReadyOffset: [-0.10, -0.06, -0.25],
    lowReadyRotation: [-0.42, 0.52, 0.15],
    rightHandSocket: {
      position: [0.024, -0.044, 0.026],
      rotation: [-0.10, 0.0, -1.55],
      gripCurl: 0.96,
    },
    leftHandSocket: {
      position: [-0.036, -0.030, -0.208],
      rotation: [0.06, -0.42, 2.22],
      gripCurl: 0.90,
    },
    muzzleOffset: [0, 0.024, -0.48],
    recoilPitchRad: 0.030,
    recoilYawRad: 0.014,
    kickBackM: 0.025,
    compatibleMagId: 'mag_556_30',
    compatibleSuppressorId: 'suppressor_rifle',
    visualStyle: 'carbine_ar',
    reloadDurationSec: 1.95,
    magCheckDurationSec: 1.15,
    meleeEnergyJ: 145,
    meleeRangeM: 1.72,
    meleeSwingDurationSec: 0.52,
  },
  akm_762: {
    id: 'akm_762',
    name: 'AKM 7.62x39',
    itemId: 'weapon_akm_762',
    caliberId: '762x39_ps',
    holdClass: 'rifle',
    slotKind: 'primary',
    fireMode: 'auto',
    rpm: 600,
    barrelLengthM: 0.80,
    hipOffset: [-0.08, -0.025, -0.28],
    adsOffset: [0, -0.054, -0.31],
    lowReadyOffset: [-0.10, -0.06, -0.25],
    lowReadyRotation: [-0.45, 0.56, 0.18],
    rightHandSocket: {
      position: [0.024, -0.044, 0.026],
      rotation: [-0.10, 0.0, -1.55],
      gripCurl: 0.96,
    },
    leftHandSocket: {
      position: [-0.036, -0.030, -0.208],
      rotation: [0.06, -0.42, 2.22],
      gripCurl: 0.90,
    },
    muzzleOffset: [0, 0.024, -0.54],
    recoilPitchRad: 0.052,
    recoilYawRad: 0.024,
    kickBackM: 0.038,
    compatibleMagId: 'mag_762_30',
    compatibleSuppressorId: 'suppressor_rifle',
    visualStyle: 'rifle_ak',
    reloadDurationSec: 2.15,
    magCheckDurationSec: 1.2,
    meleeEnergyJ: 155,
    meleeRangeM: 1.75,
    meleeSwingDurationSec: 0.54,
  },
  mp133_12ga: {
    id: 'mp133_12ga',
    name: 'MP-133 12ga Pump',
    itemId: 'weapon_mp133_12ga',
    caliberId: '12ga_00buck',
    holdClass: 'shotgun',
    slotKind: 'primary',
    fireMode: 'pump',
    rpm: 85,
    barrelLengthM: 0.82,
    hipOffset: [-0.08, -0.025, -0.28],
    adsOffset: [0, -0.052, -0.31],
    lowReadyOffset: [-0.10, -0.06, -0.25],
    lowReadyRotation: [-0.40, 0.50, 0.14],
    rightHandSocket: {
      position: [0.024, -0.042, 0.026],
      rotation: [-0.10, 0.0, -1.55],
      gripCurl: 0.96,
    },
    leftHandSocket: {
      position: [-0.034, -0.036, -0.208],
      rotation: [0.04, -0.42, 2.25],
      gripCurl: 0.92,
    },
    muzzleOffset: [0, 0.024, -0.56],
    recoilPitchRad: 0.088,
    recoilYawRad: 0.032,
    kickBackM: 0.055,
    compatibleMagId: 'mag_12ga_6',
    compatibleSuppressorId: null,
    visualStyle: 'shotgun',
    reloadDurationSec: 2.25,
    magCheckDurationSec: 1.15,
    meleeEnergyJ: 165,
    meleeRangeM: 1.78,
    meleeSwingDurationSec: 0.55,
  },
  tactical_knife: {
    id: 'tactical_knife',
    name: '6Kh4 Bayonet Knife',
    itemId: 'weapon_tactical_knife',
    caliberId: null,
    holdClass: 'melee_1h',
    slotKind: 'melee',
    fireMode: 'melee',
    rpm: 120,
    barrelLengthM: 0.28,
    hipOffset: [-0.04, 0.00, -0.31],
    adsOffset: [-0.06, -0.01, -0.30],
    lowReadyOffset: [-0.05, -0.06, -0.24],
    lowReadyRotation: [-0.45, 0.25, 0.15],
    rightHandSocket: {
      position: [0.022, 0.034, 0.036],
      rotation: [-1.22, 0.14, -1.55],
      gripCurl: 1.0,
    },
    muzzleOffset: [0, 0, -0.22],
    recoilPitchRad: 0.02,
    recoilYawRad: 0.02,
    kickBackM: 0.01,
    compatibleMagId: null,
    compatibleSuppressorId: null,
    visualStyle: 'knife',
    reloadDurationSec: 0,
    magCheckDurationSec: 0,
    meleeEnergyJ: 1650,
    meleeRangeM: 1.75,
    meleeSwingDurationSec: 0.44,
  },
  crowbar: {
    id: 'crowbar',
    name: 'Forged Pry Crowbar',
    itemId: 'weapon_crowbar',
    caliberId: null,
    holdClass: 'melee_1h',
    slotKind: 'melee',
    fireMode: 'melee',
    rpm: 90,
    barrelLengthM: 0.46,
    hipOffset: [-0.04, 0.00, -0.31],
    adsOffset: [-0.06, -0.01, -0.30],
    lowReadyOffset: [-0.05, -0.06, -0.24],
    lowReadyRotation: [-0.52, 0.30, 0.18],
    rightHandSocket: {
      position: [0.022, 0.054, 0.040],
      rotation: [-1.26, 0.12, -1.55],
      gripCurl: 1.0,
    },
    muzzleOffset: [0, 0.18, -0.26],
    recoilPitchRad: 0.03,
    recoilYawRad: 0.03,
    kickBackM: 0.015,
    compatibleMagId: null,
    compatibleSuppressorId: null,
    visualStyle: 'crowbar',
    reloadDurationSec: 0,
    magCheckDurationSec: 0,
    meleeEnergyJ: 1850,
    meleeRangeM: 1.92,
    meleeSwingDurationSec: 0.56,
  },
  rgd5_frag: {
    id: 'rgd5_frag',
    name: 'RGD-5 Frag Grenade',
    itemId: 'weapon_rgd5_frag',
    caliberId: null,
    holdClass: 'throwable',
    slotKind: 'throwable',
    fireMode: 'throwable',
    rpm: 60,
    barrelLengthM: 0.18,
    hipOffset: [-0.05, 0.01, -0.32],
    adsOffset: [-0.05, 0.01, -0.32],
    lowReadyOffset: [-0.07, -0.05, -0.25],
    lowReadyRotation: [-0.30, 0.18, 0.10],
    rightHandSocket: {
      position: [0.026, -0.004, 0.040],
      rotation: [0.08, 0.22, -1.48],
      gripCurl: 0.90,
    },
    muzzleOffset: [0, 0, -0.15],
    recoilPitchRad: 0,
    recoilYawRad: 0,
    kickBackM: 0,
    compatibleMagId: null,
    compatibleSuppressorId: null,
    visualStyle: 'frag_grenade',
    reloadDurationSec: 0,
    magCheckDurationSec: 0,
    fuseDurationSec: 3.5,
    throwVelocityMps: 18.5,
    consumableOnThrow: true,
  },
  throw_bolt: {
    id: 'throw_bolt',
    name: 'Zone M12 Metal Bolt',
    itemId: 'weapon_throw_bolt',
    caliberId: null,
    holdClass: 'throwable',
    slotKind: 'throwable',
    fireMode: 'throwable',
    rpm: 90,
    barrelLengthM: 0.16,
    hipOffset: [-0.05, 0.01, -0.32],
    adsOffset: [-0.05, 0.01, -0.32],
    lowReadyOffset: [-0.07, -0.05, -0.25],
    lowReadyRotation: [-0.28, 0.16, 0.10],
    rightHandSocket: {
      position: [0.022, -0.004, 0.030],
      rotation: [0.12, 0.25, -1.38],
      gripCurl: 0.88,
    },
    muzzleOffset: [0, 0, -0.14],
    recoilPitchRad: 0,
    recoilYawRad: 0,
    kickBackM: 0,
    compatibleMagId: null,
    compatibleSuppressorId: null,
    visualStyle: 'metal_bolt',
    reloadDurationSec: 0,
    magCheckDurationSec: 0,
    throwVelocityMps: 21.5,
    consumableOnThrow: false,
  },
};
