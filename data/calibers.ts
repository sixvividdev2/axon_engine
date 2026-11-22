export type BulletCoreType =
  | 'lead_jhp'
  | 'lead_fmj'
  | 'steel_core_ap'
  | 'tungsten_ap'
  | 'solid_steel'
  | 'soft_lead'
  | 'frangible_pellet';

export type BaseCaliberId =
  | '5.56x45'
  | '5.45x39'
  | '5.7x28'
  | '7.62x39'
  | '7.62x51'
  | '7.62x54r'
  | '338_lm'
  | '300_nm'
  | '338_nm'
  | '9x19'
  | '9x18'
  | '50_ae'
  | '44_mag'
  | '357_mag'
  | '38_spl'
  | '455_webley'
  | '7.62x38r'
  | '12ga'
  | '23x75r';

export type AmmoVariantId =
  // 5.56x45 NATO
  | '556x45_m855'
  | '556x45_m855a1'
  | '556x45_m995'
  | '556x45_mk262'
  // 5.45x39
  | '545x39_7n6'
  | '545x39_7n22'
  | '545x39_7n39'
  | '545x39_7u1'
  // 5.7x28mm
  | '57x28_ss190'
  | '57x28_ss195lf'
  | '57x28_sb193'
  // 7.62x39mm
  | '762x39_ps'
  | '762x39_7n23'
  // 7.62x51 NATO
  | '762x51_m80'
  | '762x51_m118lr'
  | '762x51_m993'
  // 7.62x54mmR
  | '762x54r_lps'
  | '762x54r_7n1'
  | '762x54r_7n14'
  // .338 Lapua Magnum
  | '338lm_250_scenar'
  | '338lm_300_scenar'
  | '338lm_ap485'
  // .300 Norma Magnum
  | '300nm_230_otm'
  // .338 Norma Magnum
  | '338nm_300_otm'
  // 9x19mm
  | '9x19_fmj'
  | '9x19_7n21'
  | '9x19_147_sub'
  // 9x18mm Makarov
  | '9x18_pst'
  | '9x18_pmm'
  // .50 AE
  | '50ae_xtp_jhp'
  | '50ae_325_fmj'
  // .44 Magnum
  | '44mag_240_sjhp'
  | '44mag_300_hc'
  // .357 Magnum
  | '357mag_125_jhp'
  | '357mag_158_jsp'
  // .38 Special
  | '38spl_158_lswc'
  | '38spl_130_fmj'
  // .455 Webley
  | '455_mk2_lead'
  // 7.62x38mmR Nagant
  | '762x38r_98_fmj'
  // 12 Gauge
  | '12ga_00buck'
  | '12ga_foster_slug'
  | '12ga_flechette'
  // 23x75mmR (KS-23)
  | '23x75r_shrapnel25'
  | '23x75r_barrikada';

/** Backward-compatible caliber ID type used by Survival Mode inventory & saves */
export type CaliberId = AmmoVariantId;

export interface CaliberDef {
  id: BaseCaliberId;
  label: string;
  shortLabel: string;
  diameterMm: number;
  caseLengthMm: number;
  defaultVariantId: AmmoVariantId;
}

export interface AmmoVariantDef {
  id: AmmoVariantId;
  caliberId: BaseCaliberId;
  label: string;
  shortName: string;
  bulletMassGrams: number;
  ballisticCoefficient: number;
  baseVelocityMs: number;
  /** Physical penetration power index (scaled with impact KE in BallisticsSolver) */
  penetrationRating: number;
  /** Terminal flesh wound cavity/expansion multiplier */
  fleshExpansionMult: number;
  isSubsonic: boolean;
  acousticRadiusMeters: number;
  suppressedAcousticRadiusMeters: number;
  coreType: BulletCoreType;
  /** 0..1 jacket/core structural hardness against high-speed shatter */
  jacketHardness: number;
  /** Speed (m/s) above which steep hard-surface strikes fragment/spall (Infinity = non-fragmenting) */
  fragmentThresholdMs: number;
  pellets: number;
  spreadMOA: number;
  woodPenetrationThresholdJ: number;
  penetrationEnergyLossRatio: number;
}

/** Legacy survival-mode compatible shape derived directly from AmmoVariantDef + CaliberDef */
export interface CaliberSpec extends AmmoVariantDef {
  muzzleVelocityMps: number;
  muzzleEnergyJ: number;
  diameterMm: number;
  baseCaliberId: BaseCaliberId;
}

export const BASE_CALIBERS: Record<BaseCaliberId, CaliberDef> = {
  '5.56x45': {
    id: '5.56x45',
    label: '5.56×45mm NATO',
    shortLabel: '5.56×45',
    diameterMm: 5.7,
    caseLengthMm: 44.7,
    defaultVariantId: '556x45_m855',
  },
  '5.45x39': {
    id: '5.45x39',
    label: '5.45×39mm',
    shortLabel: '5.45×39',
    diameterMm: 5.6,
    caseLengthMm: 39.8,
    defaultVariantId: '545x39_7n6',
  },
  '5.7x28': {
    id: '5.7x28',
    label: 'FN 5.7×28mm',
    shortLabel: '5.7×28',
    diameterMm: 5.7,
    caseLengthMm: 28.9,
    defaultVariantId: '57x28_ss190',
  },
  '7.62x39': {
    id: '7.62x39',
    label: '7.62×39mm M43',
    shortLabel: '7.62×39',
    diameterMm: 7.92,
    caseLengthMm: 38.7,
    defaultVariantId: '762x39_ps',
  },
  '7.62x51': {
    id: '7.62x51',
    label: '7.62×51mm NATO',
    shortLabel: '7.62×51',
    diameterMm: 7.82,
    caseLengthMm: 51.1,
    defaultVariantId: '762x51_m80',
  },
  '7.62x54r': {
    id: '7.62x54r',
    label: '7.62×54mmR',
    shortLabel: '7.62×54R',
    diameterMm: 7.92,
    caseLengthMm: 53.7,
    defaultVariantId: '762x54r_lps',
  },
  '338_lm': {
    id: '338_lm',
    label: '.338 Lapua Magnum',
    shortLabel: '.338 LM',
    diameterMm: 8.59,
    caseLengthMm: 69.2,
    defaultVariantId: '338lm_250_scenar',
  },
  '300_nm': {
    id: '300_nm',
    label: '.300 Norma Magnum',
    shortLabel: '.300 NM',
    diameterMm: 7.82,
    caseLengthMm: 63.3,
    defaultVariantId: '300nm_230_otm',
  },
  '338_nm': {
    id: '338_nm',
    label: '.338 Norma Magnum',
    shortLabel: '.338 NM',
    diameterMm: 8.59,
    caseLengthMm: 63.3,
    defaultVariantId: '338nm_300_otm',
  },
  '9x19': {
    id: '9x19',
    label: '9×19mm Parabellum',
    shortLabel: '9×19',
    diameterMm: 9.02,
    caseLengthMm: 19.1,
    defaultVariantId: '9x19_fmj',
  },
  '9x18': {
    id: '9x18',
    label: '9×18mm Makarov',
    shortLabel: '9×18 PM',
    diameterMm: 9.27,
    caseLengthMm: 18.1,
    defaultVariantId: '9x18_pst',
  },
  '50_ae': {
    id: '50_ae',
    label: '.50 Action Express',
    shortLabel: '.50 AE',
    diameterMm: 12.7,
    caseLengthMm: 32.6,
    defaultVariantId: '50ae_xtp_jhp',
  },
  '44_mag': {
    id: '44_mag',
    label: '.44 Remington Magnum',
    shortLabel: '.44 Mag',
    diameterMm: 10.9,
    caseLengthMm: 32.6,
    defaultVariantId: '44mag_240_sjhp',
  },
  '357_mag': {
    id: '357_mag',
    label: '.357 Magnum',
    shortLabel: '.357 Mag',
    diameterMm: 9.07,
    caseLengthMm: 32.8,
    defaultVariantId: '357mag_125_jhp',
  },
  '38_spl': {
    id: '38_spl',
    label: '.38 Special',
    shortLabel: '.38 Spl',
    diameterMm: 9.07,
    caseLengthMm: 29.3,
    defaultVariantId: '38spl_158_lswc',
  },
  '455_webley': {
    id: '455_webley',
    label: '.455 Webley Mk II',
    shortLabel: '.455 Web',
    diameterMm: 11.5,
    caseLengthMm: 19.3,
    defaultVariantId: '455_mk2_lead',
  },
  '7.62x38r': {
    id: '7.62x38r',
    label: '7.62×38mmR Nagant',
    shortLabel: '7.62×38R',
    diameterMm: 7.82,
    caseLengthMm: 38.9,
    defaultVariantId: '762x38r_98_fmj',
  },
  '12ga': {
    id: '12ga',
    label: '12 Gauge (2¾")',
    shortLabel: '12ga',
    diameterMm: 18.5,
    caseLengthMm: 70.0,
    defaultVariantId: '12ga_00buck',
  },
  '23x75r': {
    id: '23x75r',
    label: '23×75mmR (KS-23)',
    shortLabel: '23×75R',
    diameterMm: 23.0,
    caseLengthMm: 75.0,
    defaultVariantId: '23x75r_shrapnel25',
  },
};

export const AMMO_VARIANTS: Record<AmmoVariantId, AmmoVariantDef> = {
  // === 5.56x45 NATO ===
  '556x45_m855': {
    id: '556x45_m855',
    caliberId: '5.56x45',
    label: '5.56×45 NATO M855 62gr FMJ',
    shortName: 'M855 62gr',
    bulletMassGrams: 4.0,
    ballisticCoefficient: 0.304,
    baseVelocityMs: 948,
    penetrationRating: 0.56,
    fleshExpansionMult: 1.08,
    isSubsonic: false,
    acousticRadiusMeters: 185,
    suppressedAcousticRadiusMeters: 48,
    coreType: 'lead_fmj',
    jacketHardness: 0.72,
    fragmentThresholdMs: 780,
    pellets: 1,
    spreadMOA: 2.1,
    woodPenetrationThresholdJ: 340,
    penetrationEnergyLossRatio: 0.28,
  },
  '556x45_m855a1': {
    id: '556x45_m855a1',
    caliberId: '5.56x45',
    label: '5.56×45 NATO M855A1 EPR',
    shortName: 'M855A1 EPR',
    bulletMassGrams: 4.0,
    ballisticCoefficient: 0.31,
    baseVelocityMs: 961,
    penetrationRating: 0.76,
    fleshExpansionMult: 1.18,
    isSubsonic: false,
    acousticRadiusMeters: 190,
    suppressedAcousticRadiusMeters: 50,
    coreType: 'steel_core_ap',
    jacketHardness: 0.82,
    fragmentThresholdMs: 810,
    pellets: 1,
    spreadMOA: 1.9,
    woodPenetrationThresholdJ: 260,
    penetrationEnergyLossRatio: 0.22,
  },
  '556x45_m995': {
    id: '556x45_m995',
    caliberId: '5.56x45',
    label: '5.56×45 NATO M995 AP (Tungsten)',
    shortName: 'M995 AP',
    bulletMassGrams: 3.37,
    ballisticCoefficient: 0.282,
    baseVelocityMs: 1013,
    penetrationRating: 0.92,
    fleshExpansionMult: 0.88,
    isSubsonic: false,
    acousticRadiusMeters: 195,
    suppressedAcousticRadiusMeters: 52,
    coreType: 'tungsten_ap',
    jacketHardness: 0.96,
    fragmentThresholdMs: 1200,
    pellets: 1,
    spreadMOA: 2.0,
    woodPenetrationThresholdJ: 190,
    penetrationEnergyLossRatio: 0.14,
  },
  '556x45_mk262': {
    id: '556x45_mk262',
    caliberId: '5.56x45',
    label: '5.56×45 NATO Mk262 77gr OTM',
    shortName: 'Mk262 77gr',
    bulletMassGrams: 5.0,
    ballisticCoefficient: 0.372,
    baseVelocityMs: 838,
    penetrationRating: 0.44,
    fleshExpansionMult: 1.38,
    isSubsonic: false,
    acousticRadiusMeters: 180,
    suppressedAcousticRadiusMeters: 44,
    coreType: 'lead_jhp',
    jacketHardness: 0.56,
    fragmentThresholdMs: 740,
    pellets: 1,
    spreadMOA: 1.2,
    woodPenetrationThresholdJ: 390,
    penetrationEnergyLossRatio: 0.36,
  },

  // === 5.45x39 ===
  '545x39_7n6': {
    id: '545x39_7n6',
    caliberId: '5.45x39',
    label: '5.45×39mm 7N6 PS',
    shortName: '7N6 PS',
    bulletMassGrams: 3.43,
    ballisticCoefficient: 0.26,
    baseVelocityMs: 890,
    penetrationRating: 0.58,
    fleshExpansionMult: 1.12,
    isSubsonic: false,
    acousticRadiusMeters: 175,
    suppressedAcousticRadiusMeters: 45,
    coreType: 'steel_core_ap',
    jacketHardness: 0.78,
    fragmentThresholdMs: 860,
    pellets: 1,
    spreadMOA: 2.6,
    woodPenetrationThresholdJ: 350,
    penetrationEnergyLossRatio: 0.30,
  },
  '545x39_7n22': {
    id: '545x39_7n22',
    caliberId: '5.45x39',
    label: '5.45×39mm 7N22 BP AP',
    shortName: '7N22 BP',
    bulletMassGrams: 3.7,
    ballisticCoefficient: 0.285,
    baseVelocityMs: 890,
    penetrationRating: 0.80,
    fleshExpansionMult: 0.96,
    isSubsonic: false,
    acousticRadiusMeters: 180,
    suppressedAcousticRadiusMeters: 46,
    coreType: 'steel_core_ap',
    jacketHardness: 0.90,
    fragmentThresholdMs: 1120,
    pellets: 1,
    spreadMOA: 2.3,
    woodPenetrationThresholdJ: 240,
    penetrationEnergyLossRatio: 0.20,
  },
  '545x39_7n39': {
    id: '545x39_7n39',
    caliberId: '5.45x39',
    label: '5.45×39mm 7N39 Igolnik AP',
    shortName: '7N39 Igolnik',
    bulletMassGrams: 4.1,
    ballisticCoefficient: 0.305,
    baseVelocityMs: 905,
    penetrationRating: 0.94,
    fleshExpansionMult: 0.86,
    isSubsonic: false,
    acousticRadiusMeters: 184,
    suppressedAcousticRadiusMeters: 47,
    coreType: 'tungsten_ap',
    jacketHardness: 0.97,
    fragmentThresholdMs: 1240,
    pellets: 1,
    spreadMOA: 2.1,
    woodPenetrationThresholdJ: 180,
    penetrationEnergyLossRatio: 0.14,
  },
  '545x39_7u1': {
    id: '545x39_7u1',
    caliberId: '5.45x39',
    label: '5.45×39mm 7U1 Subsonic',
    shortName: '7U1 Subsonic',
    bulletMassGrams: 5.2,
    ballisticCoefficient: 0.22,
    baseVelocityMs: 303,
    penetrationRating: 0.30,
    fleshExpansionMult: 1.05,
    isSubsonic: true,
    acousticRadiusMeters: 105,
    suppressedAcousticRadiusMeters: 14,
    coreType: 'lead_fmj',
    jacketHardness: 0.68,
    fragmentThresholdMs: 950,
    pellets: 1,
    spreadMOA: 3.4,
    woodPenetrationThresholdJ: 380,
    penetrationEnergyLossRatio: 0.44,
  },

  // === 5.7x28mm ===
  '57x28_ss190': {
    id: '57x28_ss190',
    caliberId: '5.7x28',
    label: '5.7×28mm SS190 AP',
    shortName: 'SS190 AP',
    bulletMassGrams: 2.0,
    ballisticCoefficient: 0.18,
    baseVelocityMs: 715,
    penetrationRating: 0.68,
    fleshExpansionMult: 1.04,
    isSubsonic: false,
    acousticRadiusMeters: 138,
    suppressedAcousticRadiusMeters: 34,
    coreType: 'steel_core_ap',
    jacketHardness: 0.84,
    fragmentThresholdMs: 940,
    pellets: 1,
    spreadMOA: 2.8,
    woodPenetrationThresholdJ: 270,
    penetrationEnergyLossRatio: 0.26,
  },
  '57x28_ss195lf': {
    id: '57x28_ss195lf',
    caliberId: '5.7x28',
    label: '5.7×28mm SS195LF JHP',
    shortName: 'SS195LF JHP',
    bulletMassGrams: 1.8,
    ballisticCoefficient: 0.162,
    baseVelocityMs: 625,
    penetrationRating: 0.34,
    fleshExpansionMult: 1.32,
    isSubsonic: false,
    acousticRadiusMeters: 132,
    suppressedAcousticRadiusMeters: 31,
    coreType: 'lead_jhp',
    jacketHardness: 0.54,
    fragmentThresholdMs: 720,
    pellets: 1,
    spreadMOA: 2.6,
    woodPenetrationThresholdJ: 340,
    penetrationEnergyLossRatio: 0.42,
  },
  '57x28_sb193': {
    id: '57x28_sb193',
    caliberId: '5.7x28',
    label: '5.7×28mm SB193 Subsonic',
    shortName: 'SB193 Sub',
    bulletMassGrams: 3.6,
    ballisticCoefficient: 0.205,
    baseVelocityMs: 305,
    penetrationRating: 0.28,
    fleshExpansionMult: 1.02,
    isSubsonic: true,
    acousticRadiusMeters: 86,
    suppressedAcousticRadiusMeters: 11,
    coreType: 'lead_fmj',
    jacketHardness: 0.66,
    fragmentThresholdMs: 900,
    pellets: 1,
    spreadMOA: 3.1,
    woodPenetrationThresholdJ: 360,
    penetrationEnergyLossRatio: 0.48,
  },

  // === 7.62x39mm ===
  '762x39_ps': {
    id: '762x39_ps',
    caliberId: '7.62x39',
    label: '7.62×39mm PS gzh',
    shortName: '7.62×39 PS',
    bulletMassGrams: 7.97,
    ballisticCoefficient: 0.275,
    baseVelocityMs: 715,
    penetrationRating: 0.64,
    fleshExpansionMult: 1.12,
    isSubsonic: false,
    acousticRadiusMeters: 195,
    suppressedAcousticRadiusMeters: 52,
    coreType: 'steel_core_ap',
    jacketHardness: 0.80,
    fragmentThresholdMs: 980,
    pellets: 1,
    spreadMOA: 3.2,
    woodPenetrationThresholdJ: 300,
    penetrationEnergyLossRatio: 0.24,
  },
  '762x39_7n23': {
    id: '762x39_7n23',
    caliberId: '7.62x39',
    label: '7.62×39mm 7N23 BP AP',
    shortName: '7N23 BP',
    bulletMassGrams: 7.9,
    ballisticCoefficient: 0.292,
    baseVelocityMs: 730,
    penetrationRating: 0.82,
    fleshExpansionMult: 0.98,
    isSubsonic: false,
    acousticRadiusMeters: 198,
    suppressedAcousticRadiusMeters: 54,
    coreType: 'steel_core_ap',
    jacketHardness: 0.91,
    fragmentThresholdMs: 1140,
    pellets: 1,
    spreadMOA: 2.9,
    woodPenetrationThresholdJ: 240,
    penetrationEnergyLossRatio: 0.18,
  },

  // === 7.62x51 NATO ===
  '762x51_m80': {
    id: '762x51_m80',
    caliberId: '7.62x51',
    label: '7.62×51 NATO M80 147gr FMJ',
    shortName: 'M80 147gr',
    bulletMassGrams: 9.5,
    ballisticCoefficient: 0.395,
    baseVelocityMs: 853,
    penetrationRating: 0.68,
    fleshExpansionMult: 1.16,
    isSubsonic: false,
    acousticRadiusMeters: 235,
    suppressedAcousticRadiusMeters: 64,
    coreType: 'lead_fmj',
    jacketHardness: 0.74,
    fragmentThresholdMs: 920,
    pellets: 1,
    spreadMOA: 1.6,
    woodPenetrationThresholdJ: 260,
    penetrationEnergyLossRatio: 0.20,
  },
  '762x51_m118lr': {
    id: '762x51_m118lr',
    caliberId: '7.62x51',
    label: '7.62×51 NATO M118LR 175gr Match',
    shortName: 'M118LR 175gr',
    bulletMassGrams: 11.34,
    ballisticCoefficient: 0.496,
    baseVelocityMs: 792,
    penetrationRating: 0.62,
    fleshExpansionMult: 1.32,
    isSubsonic: false,
    acousticRadiusMeters: 232,
    suppressedAcousticRadiusMeters: 60,
    coreType: 'lead_jhp',
    jacketHardness: 0.66,
    fragmentThresholdMs: 820,
    pellets: 1,
    spreadMOA: 0.85,
    woodPenetrationThresholdJ: 280,
    penetrationEnergyLossRatio: 0.24,
  },
  '762x51_m993': {
    id: '762x51_m993',
    caliberId: '7.62x51',
    label: '7.62×51 NATO M993 AP (Tungsten)',
    shortName: 'M993 AP',
    bulletMassGrams: 8.2,
    ballisticCoefficient: 0.365,
    baseVelocityMs: 910,
    penetrationRating: 0.96,
    fleshExpansionMult: 0.94,
    isSubsonic: false,
    acousticRadiusMeters: 245,
    suppressedAcousticRadiusMeters: 68,
    coreType: 'tungsten_ap',
    jacketHardness: 0.97,
    fragmentThresholdMs: 1300,
    pellets: 1,
    spreadMOA: 1.35,
    woodPenetrationThresholdJ: 170,
    penetrationEnergyLossRatio: 0.12,
  },

  // === 7.62x54mmR ===
  '762x54r_lps': {
    id: '762x54r_lps',
    caliberId: '7.62x54r',
    label: '7.62×54mmR 57-N-323S LPS',
    shortName: '57-N-323S LPS',
    bulletMassGrams: 9.6,
    ballisticCoefficient: 0.374,
    baseVelocityMs: 865,
    penetrationRating: 0.74,
    fleshExpansionMult: 1.15,
    isSubsonic: false,
    acousticRadiusMeters: 242,
    suppressedAcousticRadiusMeters: 66,
    coreType: 'steel_core_ap',
    jacketHardness: 0.82,
    fragmentThresholdMs: 980,
    pellets: 1,
    spreadMOA: 1.8,
    woodPenetrationThresholdJ: 250,
    penetrationEnergyLossRatio: 0.19,
  },
  '762x54r_7n1': {
    id: '762x54r_7n1',
    caliberId: '7.62x54r',
    label: '7.62×54mmR 7N1 Sniper',
    shortName: '7N1 Sniper',
    bulletMassGrams: 9.8,
    ballisticCoefficient: 0.411,
    baseVelocityMs: 830,
    penetrationRating: 0.72,
    fleshExpansionMult: 1.24,
    isSubsonic: false,
    acousticRadiusMeters: 238,
    suppressedAcousticRadiusMeters: 64,
    coreType: 'lead_fmj',
    jacketHardness: 0.76,
    fragmentThresholdMs: 900,
    pellets: 1,
    spreadMOA: 1.05,
    woodPenetrationThresholdJ: 260,
    penetrationEnergyLossRatio: 0.21,
  },
  '762x54r_7n14': {
    id: '762x54r_7n14',
    caliberId: '7.62x54r',
    label: '7.62×54mmR 7N14 SNB/AP',
    shortName: '7N14 SNB/AP',
    bulletMassGrams: 9.8,
    ballisticCoefficient: 0.422,
    baseVelocityMs: 830,
    penetrationRating: 0.94,
    fleshExpansionMult: 1.04,
    isSubsonic: false,
    acousticRadiusMeters: 244,
    suppressedAcousticRadiusMeters: 67,
    coreType: 'steel_core_ap',
    jacketHardness: 0.94,
    fragmentThresholdMs: 1220,
    pellets: 1,
    spreadMOA: 1.15,
    woodPenetrationThresholdJ: 190,
    penetrationEnergyLossRatio: 0.14,
  },

  // === .338 Lapua Magnum ===
  '338lm_250_scenar': {
    id: '338lm_250_scenar',
    caliberId: '338_lm',
    label: '.338 Lapua 250gr Scenar',
    shortName: '250gr Scenar',
    bulletMassGrams: 16.2,
    ballisticCoefficient: 0.648,
    baseVelocityMs: 920,
    penetrationRating: 0.84,
    fleshExpansionMult: 1.42,
    isSubsonic: false,
    acousticRadiusMeters: 310,
    suppressedAcousticRadiusMeters: 86,
    coreType: 'lead_fmj',
    jacketHardness: 0.78,
    fragmentThresholdMs: 940,
    pellets: 1,
    spreadMOA: 0.65,
    woodPenetrationThresholdJ: 220,
    penetrationEnergyLossRatio: 0.14,
  },
  '338lm_300_scenar': {
    id: '338lm_300_scenar',
    caliberId: '338_lm',
    label: '.338 Lapua 300gr Scenar OTM',
    shortName: '300gr OTM',
    bulletMassGrams: 19.44,
    ballisticCoefficient: 0.736,
    baseVelocityMs: 835,
    penetrationRating: 0.82,
    fleshExpansionMult: 1.52,
    isSubsonic: false,
    acousticRadiusMeters: 315,
    suppressedAcousticRadiusMeters: 88,
    coreType: 'lead_jhp',
    jacketHardness: 0.74,
    fragmentThresholdMs: 860,
    pellets: 1,
    spreadMOA: 0.55,
    woodPenetrationThresholdJ: 220,
    penetrationEnergyLossRatio: 0.15,
  },
  '338lm_ap485': {
    id: '338lm_ap485',
    caliberId: '338_lm',
    label: '.338 Lapua 300gr AP485',
    shortName: '300gr AP485',
    bulletMassGrams: 19.44,
    ballisticCoefficient: 0.715,
    baseVelocityMs: 830,
    penetrationRating: 1.0,
    fleshExpansionMult: 1.15,
    isSubsonic: false,
    acousticRadiusMeters: 320,
    suppressedAcousticRadiusMeters: 90,
    coreType: 'tungsten_ap',
    jacketHardness: 0.99,
    fragmentThresholdMs: 1400,
    pellets: 1,
    spreadMOA: 0.85,
    woodPenetrationThresholdJ: 150,
    penetrationEnergyLossRatio: 0.08,
  },

  // === .300 Norma Magnum ===
  '300nm_230_otm': {
    id: '300nm_230_otm',
    caliberId: '300_nm',
    label: '.300 Norma 230gr Hybrid OTM',
    shortName: '230gr Hybrid',
    bulletMassGrams: 14.9,
    ballisticCoefficient: 0.717,
    baseVelocityMs: 894,
    penetrationRating: 0.82,
    fleshExpansionMult: 1.44,
    isSubsonic: false,
    acousticRadiusMeters: 295,
    suppressedAcousticRadiusMeters: 82,
    coreType: 'lead_jhp',
    jacketHardness: 0.72,
    fragmentThresholdMs: 870,
    pellets: 1,
    spreadMOA: 0.55,
    woodPenetrationThresholdJ: 230,
    penetrationEnergyLossRatio: 0.16,
  },

  // === .338 Norma Magnum ===
  '338nm_300_otm': {
    id: '338nm_300_otm',
    caliberId: '338_nm',
    label: '.338 Norma 300gr Hybrid OTM',
    shortName: '300gr Hybrid',
    bulletMassGrams: 19.44,
    ballisticCoefficient: 0.822,
    baseVelocityMs: 826,
    penetrationRating: 0.86,
    fleshExpansionMult: 1.54,
    isSubsonic: false,
    acousticRadiusMeters: 310,
    suppressedAcousticRadiusMeters: 86,
    coreType: 'lead_jhp',
    jacketHardness: 0.75,
    fragmentThresholdMs: 855,
    pellets: 1,
    spreadMOA: 0.52,
    woodPenetrationThresholdJ: 210,
    penetrationEnergyLossRatio: 0.14,
  },

  // === 9x19mm ===
  '9x19_fmj': {
    id: '9x19_fmj',
    caliberId: '9x19',
    label: '9×19mm 124gr FMJ',
    shortName: '124gr FMJ',
    bulletMassGrams: 8.04,
    ballisticCoefficient: 0.149,
    baseVelocityMs: 360,
    penetrationRating: 0.30,
    fleshExpansionMult: 1.0,
    isSubsonic: false,
    acousticRadiusMeters: 95,
    suppressedAcousticRadiusMeters: 24,
    coreType: 'lead_fmj',
    jacketHardness: 0.65,
    fragmentThresholdMs: 900,
    pellets: 1,
    spreadMOA: 4.2,
    woodPenetrationThresholdJ: 420,
    penetrationEnergyLossRatio: 0.55,
  },
  '9x19_7n21': {
    id: '9x19_7n21',
    caliberId: '9x19',
    label: '9×19mm 7N21 +P+ AP',
    shortName: '7N21 +P+ AP',
    bulletMassGrams: 5.2,
    ballisticCoefficient: 0.14,
    baseVelocityMs: 460,
    penetrationRating: 0.60,
    fleshExpansionMult: 0.98,
    isSubsonic: false,
    acousticRadiusMeters: 108,
    suppressedAcousticRadiusMeters: 29,
    coreType: 'steel_core_ap',
    jacketHardness: 0.88,
    fragmentThresholdMs: 960,
    pellets: 1,
    spreadMOA: 4.0,
    woodPenetrationThresholdJ: 300,
    penetrationEnergyLossRatio: 0.34,
  },
  '9x19_147_sub': {
    id: '9x19_147_sub',
    caliberId: '9x19',
    label: '9×19mm 147gr Subsonic JHP',
    shortName: '147gr Sub JHP',
    bulletMassGrams: 9.53,
    ballisticCoefficient: 0.165,
    baseVelocityMs: 297,
    penetrationRating: 0.22,
    fleshExpansionMult: 1.38,
    isSubsonic: true,
    acousticRadiusMeters: 74,
    suppressedAcousticRadiusMeters: 9,
    coreType: 'lead_jhp',
    jacketHardness: 0.48,
    fragmentThresholdMs: 750,
    pellets: 1,
    spreadMOA: 3.9,
    woodPenetrationThresholdJ: 450,
    penetrationEnergyLossRatio: 0.62,
  },

  // === 9x18mm Makarov ===
  '9x18_pst': {
    id: '9x18_pst',
    caliberId: '9x18',
    label: '9×18mm 57-N-181S PST',
    shortName: '57-N-181S PST',
    bulletMassGrams: 6.1,
    ballisticCoefficient: 0.115,
    baseVelocityMs: 319,
    penetrationRating: 0.26,
    fleshExpansionMult: 0.96,
    isSubsonic: true,
    acousticRadiusMeters: 80,
    suppressedAcousticRadiusMeters: 12,
    coreType: 'steel_core_ap',
    jacketHardness: 0.74,
    fragmentThresholdMs: 900,
    pellets: 1,
    spreadMOA: 5.0,
    woodPenetrationThresholdJ: 440,
    penetrationEnergyLossRatio: 0.58,
  },
  '9x18_pmm': {
    id: '9x18_pmm',
    caliberId: '9x18',
    label: '9×18mm PMM +P+',
    shortName: 'PMM +P+',
    bulletMassGrams: 5.5,
    ballisticCoefficient: 0.11,
    baseVelocityMs: 420,
    penetrationRating: 0.40,
    fleshExpansionMult: 1.08,
    isSubsonic: false,
    acousticRadiusMeters: 96,
    suppressedAcousticRadiusMeters: 24,
    coreType: 'lead_fmj',
    jacketHardness: 0.68,
    fragmentThresholdMs: 880,
    pellets: 1,
    spreadMOA: 4.8,
    woodPenetrationThresholdJ: 360,
    penetrationEnergyLossRatio: 0.48,
  },

  // === .50 AE ===
  '50ae_xtp_jhp': {
    id: '50ae_xtp_jhp',
    caliberId: '50_ae',
    label: '.50 AE 300gr XTP JHP',
    shortName: '300gr XTP JHP',
    bulletMassGrams: 19.4,
    ballisticCoefficient: 0.165,
    baseVelocityMs: 460,
    penetrationRating: 0.54,
    fleshExpansionMult: 1.65,
    isSubsonic: false,
    acousticRadiusMeters: 165,
    suppressedAcousticRadiusMeters: 54,
    coreType: 'lead_jhp',
    jacketHardness: 0.58,
    fragmentThresholdMs: 760,
    pellets: 1,
    spreadMOA: 3.4,
    woodPenetrationThresholdJ: 310,
    penetrationEnergyLossRatio: 0.34,
  },
  '50ae_325_fmj': {
    id: '50ae_325_fmj',
    caliberId: '50_ae',
    label: '.50 AE 325gr FMJ',
    shortName: '325gr FMJ',
    bulletMassGrams: 21.06,
    ballisticCoefficient: 0.178,
    baseVelocityMs: 425,
    penetrationRating: 0.68,
    fleshExpansionMult: 1.24,
    isSubsonic: false,
    acousticRadiusMeters: 162,
    suppressedAcousticRadiusMeters: 52,
    coreType: 'lead_fmj',
    jacketHardness: 0.72,
    fragmentThresholdMs: 860,
    pellets: 1,
    spreadMOA: 3.5,
    woodPenetrationThresholdJ: 270,
    penetrationEnergyLossRatio: 0.28,
  },

  // === .44 Magnum ===
  '44mag_240_sjhp': {
    id: '44mag_240_sjhp',
    caliberId: '44_mag',
    label: '.44 Magnum 240gr SJHP',
    shortName: '240gr SJHP',
    bulletMassGrams: 15.55,
    ballisticCoefficient: 0.172,
    baseVelocityMs: 410,
    penetrationRating: 0.48,
    fleshExpansionMult: 1.52,
    isSubsonic: false,
    acousticRadiusMeters: 148,
    suppressedAcousticRadiusMeters: 48,
    coreType: 'lead_jhp',
    jacketHardness: 0.56,
    fragmentThresholdMs: 760,
    pellets: 1,
    spreadMOA: 3.6,
    woodPenetrationThresholdJ: 330,
    penetrationEnergyLossRatio: 0.38,
  },
  '44mag_300_hc': {
    id: '44mag_300_hc',
    caliberId: '44_mag',
    label: '.44 Magnum 300gr Hard Cast',
    shortName: '300gr Hard Cast',
    bulletMassGrams: 19.44,
    ballisticCoefficient: 0.21,
    baseVelocityMs: 385,
    penetrationRating: 0.64,
    fleshExpansionMult: 1.18,
    isSubsonic: false,
    acousticRadiusMeters: 145,
    suppressedAcousticRadiusMeters: 46,
    coreType: 'soft_lead',
    jacketHardness: 0.62,
    fragmentThresholdMs: 840,
    pellets: 1,
    spreadMOA: 3.8,
    woodPenetrationThresholdJ: 260,
    penetrationEnergyLossRatio: 0.25,
  },

  // === .357 Magnum ===
  '357mag_125_jhp': {
    id: '357mag_125_jhp',
    caliberId: '357_mag',
    label: '.357 Magnum 125gr JHP',
    shortName: '125gr JHP',
    bulletMassGrams: 8.1,
    ballisticCoefficient: 0.148,
    baseVelocityMs: 440,
    penetrationRating: 0.38,
    fleshExpansionMult: 1.44,
    isSubsonic: false,
    acousticRadiusMeters: 130,
    suppressedAcousticRadiusMeters: 42,
    coreType: 'lead_jhp',
    jacketHardness: 0.54,
    fragmentThresholdMs: 740,
    pellets: 1,
    spreadMOA: 3.8,
    woodPenetrationThresholdJ: 360,
    penetrationEnergyLossRatio: 0.45,
  },
  '357mag_158_jsp': {
    id: '357mag_158_jsp',
    caliberId: '357_mag',
    label: '.357 Magnum 158gr JSP',
    shortName: '158gr JSP',
    bulletMassGrams: 10.2,
    ballisticCoefficient: 0.168,
    baseVelocityMs: 380,
    penetrationRating: 0.48,
    fleshExpansionMult: 1.22,
    isSubsonic: false,
    acousticRadiusMeters: 126,
    suppressedAcousticRadiusMeters: 40,
    coreType: 'lead_fmj',
    jacketHardness: 0.64,
    fragmentThresholdMs: 820,
    pellets: 1,
    spreadMOA: 3.7,
    woodPenetrationThresholdJ: 320,
    penetrationEnergyLossRatio: 0.36,
  },

  // === .38 Special ===
  '38spl_158_lswc': {
    id: '38spl_158_lswc',
    caliberId: '38_spl',
    label: '.38 Special 158gr LSWC',
    shortName: '158gr LSWC',
    bulletMassGrams: 10.2,
    ballisticCoefficient: 0.155,
    baseVelocityMs: 265,
    penetrationRating: 0.22,
    fleshExpansionMult: 1.18,
    isSubsonic: true,
    acousticRadiusMeters: 78,
    suppressedAcousticRadiusMeters: 18,
    coreType: 'soft_lead',
    jacketHardness: 0.35,
    fragmentThresholdMs: 650,
    pellets: 1,
    spreadMOA: 4.4,
    woodPenetrationThresholdJ: 460,
    penetrationEnergyLossRatio: 0.62,
  },
  '38spl_130_fmj': {
    id: '38spl_130_fmj',
    caliberId: '38_spl',
    label: '.38 Special 130gr FMJ',
    shortName: '130gr FMJ',
    bulletMassGrams: 8.42,
    ballisticCoefficient: 0.14,
    baseVelocityMs: 290,
    penetrationRating: 0.25,
    fleshExpansionMult: 1.0,
    isSubsonic: true,
    acousticRadiusMeters: 82,
    suppressedAcousticRadiusMeters: 20,
    coreType: 'lead_fmj',
    jacketHardness: 0.60,
    fragmentThresholdMs: 820,
    pellets: 1,
    spreadMOA: 4.3,
    woodPenetrationThresholdJ: 440,
    penetrationEnergyLossRatio: 0.58,
  },

  // === .455 Webley ===
  '455_mk2_lead': {
    id: '455_mk2_lead',
    caliberId: '455_webley',
    label: '.455 Webley 265gr Mk II Lead',
    shortName: '265gr Mk II',
    bulletMassGrams: 17.2,
    ballisticCoefficient: 0.175,
    baseVelocityMs: 213,
    penetrationRating: 0.20,
    fleshExpansionMult: 1.56,
    isSubsonic: true,
    acousticRadiusMeters: 76,
    suppressedAcousticRadiusMeters: 22,
    coreType: 'soft_lead',
    jacketHardness: 0.32,
    fragmentThresholdMs: 620,
    pellets: 1,
    spreadMOA: 4.9,
    woodPenetrationThresholdJ: 480,
    penetrationEnergyLossRatio: 0.64,
  },

  // === 7.62x38mmR Nagant ===
  '762x38r_98_fmj': {
    id: '762x38r_98_fmj',
    caliberId: '7.62x38r',
    label: '7.62×38mmR 98gr FMJ (Gas-Seal)',
    shortName: '98gr FMJ',
    bulletMassGrams: 6.35,
    ballisticCoefficient: 0.13,
    baseVelocityMs: 272,
    penetrationRating: 0.24,
    fleshExpansionMult: 0.95,
    isSubsonic: true,
    acousticRadiusMeters: 72,
    suppressedAcousticRadiusMeters: 8,
    coreType: 'lead_fmj',
    jacketHardness: 0.64,
    fragmentThresholdMs: 840,
    pellets: 1,
    spreadMOA: 4.6,
    woodPenetrationThresholdJ: 440,
    penetrationEnergyLossRatio: 0.56,
  },

  // === 12 Gauge ===
  '12ga_00buck': {
    id: '12ga_00buck',
    caliberId: '12ga',
    label: '12ga 00 Buckshot (9-Pellet)',
    shortName: '00 Buckshot',
    bulletMassGrams: 3.5,
    ballisticCoefficient: 0.045,
    baseVelocityMs: 404,
    penetrationRating: 0.26,
    fleshExpansionMult: 1.15,
    isSubsonic: false,
    acousticRadiusMeters: 200,
    suppressedAcousticRadiusMeters: 115,
    coreType: 'soft_lead',
    jacketHardness: 0.38,
    fragmentThresholdMs: 680,
    pellets: 9,
    spreadMOA: 34.0,
    woodPenetrationThresholdJ: 310,
    penetrationEnergyLossRatio: 0.65,
  },
  '12ga_foster_slug': {
    id: '12ga_foster_slug',
    caliberId: '12ga',
    label: '12ga 1oz Foster Slug',
    shortName: '1oz Slug',
    bulletMassGrams: 28.3,
    ballisticCoefficient: 0.068,
    baseVelocityMs: 475,
    penetrationRating: 0.68,
    fleshExpansionMult: 1.72,
    isSubsonic: false,
    acousticRadiusMeters: 210,
    suppressedAcousticRadiusMeters: 120,
    coreType: 'soft_lead',
    jacketHardness: 0.45,
    fragmentThresholdMs: 700,
    pellets: 1,
    spreadMOA: 4.8,
    woodPenetrationThresholdJ: 240,
    penetrationEnergyLossRatio: 0.30,
  },
  '12ga_flechette': {
    id: '12ga_flechette',
    caliberId: '12ga',
    label: '12ga Flechette (20-Dart)',
    shortName: 'Flechette',
    bulletMassGrams: 1.0,
    ballisticCoefficient: 0.115,
    baseVelocityMs: 420,
    penetrationRating: 0.62,
    fleshExpansionMult: 0.90,
    isSubsonic: false,
    acousticRadiusMeters: 196,
    suppressedAcousticRadiusMeters: 110,
    coreType: 'solid_steel',
    jacketHardness: 0.94,
    fragmentThresholdMs: 1200,
    pellets: 20,
    spreadMOA: 28.0,
    woodPenetrationThresholdJ: 190,
    penetrationEnergyLossRatio: 0.24,
  },

  // === 23x75mmR (KS-23) ===
  '23x75r_shrapnel25': {
    id: '23x75r_shrapnel25',
    caliberId: '23x75r',
    label: '23×75mmR Shrapnel-25 (8-Pellet)',
    shortName: 'Shrapnel-25',
    bulletMassGrams: 6.2,
    ballisticCoefficient: 0.055,
    baseVelocityMs: 390,
    penetrationRating: 0.42,
    fleshExpansionMult: 1.35,
    isSubsonic: false,
    acousticRadiusMeters: 235,
    suppressedAcousticRadiusMeters: 160,
    coreType: 'soft_lead',
    jacketHardness: 0.44,
    fragmentThresholdMs: 680,
    pellets: 8,
    spreadMOA: 36.0,
    woodPenetrationThresholdJ: 280,
    penetrationEnergyLossRatio: 0.48,
  },
  '23x75r_barrikada': {
    id: '23x75r_barrikada',
    caliberId: '23x75r',
    label: '23×75mmR Barrikada Solid Steel Slug',
    shortName: 'Barrikada',
    bulletMassGrams: 52.0,
    ballisticCoefficient: 0.145,
    baseVelocityMs: 415,
    penetrationRating: 0.95,
    fleshExpansionMult: 1.85,
    isSubsonic: false,
    acousticRadiusMeters: 245,
    suppressedAcousticRadiusMeters: 165,
    coreType: 'solid_steel',
    jacketHardness: 0.98,
    fragmentThresholdMs: 1400,
    pellets: 1,
    spreadMOA: 4.2,
    woodPenetrationThresholdJ: 150,
    penetrationEnergyLossRatio: 0.10,
  },
};

const _variantsByCaliber = new Map<BaseCaliberId, AmmoVariantDef[]>();
for (const key of Object.keys(AMMO_VARIANTS) as AmmoVariantId[]) {
  const v = AMMO_VARIANTS[key];
  let list = _variantsByCaliber.get(v.caliberId);
  if (!list) {
    list = [];
    _variantsByCaliber.set(v.caliberId, list);
  }
  list.push(v);
}

export function resolveBaseCaliberId(rawId?: string | null): BaseCaliberId {
  if (!rawId) return '5.56x45';
  if (rawId in BASE_CALIBERS) return rawId as BaseCaliberId;
  const alias: Record<string, BaseCaliberId> = {
    '556x45': '5.56x45',
    '545x39': '5.45x39',
    '57x28': '5.7x28',
    '762x39': '7.62x39',
    '762x51': '7.62x51',
    '762x54r': '7.62x54r',
    '762x38r': '7.62x38r',
  };
  return alias[rawId] ?? '5.56x45';
}

export function getAmmoVariantsForCaliber(caliberId: BaseCaliberId | string): readonly AmmoVariantDef[] {
  const resolved = resolveBaseCaliberId(caliberId);
  return _variantsByCaliber.get(resolved) ?? [];
}

export function getDefaultAmmoVariant(caliberId?: string | null): AmmoVariantDef {
  const resolved = resolveBaseCaliberId(caliberId);
  const def = BASE_CALIBERS[resolved];
  return AMMO_VARIANTS[def.defaultVariantId];
}

/**
 * Backward-compatible CALIBERS dictionary keyed by AmmoVariantId (= CaliberId)
 * so existing Survival Mode code & IndexedDB saves continue working seamlessly.
 */
export const CALIBERS: Record<CaliberId, CaliberSpec> = Object.fromEntries(
  (Object.keys(AMMO_VARIANTS) as AmmoVariantId[]).map((id) => {
    const v = AMMO_VARIANTS[id];
    const cal = BASE_CALIBERS[v.caliberId];
    const energyJ = Math.round(0.5 * (v.bulletMassGrams * 0.001) * v.baseVelocityMs * v.baseVelocityMs);
    const spec: CaliberSpec = {
      ...v,
      muzzleVelocityMps: v.baseVelocityMs,
      muzzleEnergyJ: energyJ,
      diameterMm: cal.diameterMm,
      baseCaliberId: v.caliberId,
    };
    return [id, spec];
  }),
) as Record<CaliberId, CaliberSpec>;
