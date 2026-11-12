import {
  STYLE_DEFINITION_REGISTRY,
  type CharcoalStyleOverrides,
  type ShotScene,
} from '@filmmaking/contracts';

export const CHARCOAL_HORROR_STYLE = {
  id: 'charcoal_horror',
  version: '1.2.0',
  palette: {
    shadow: [0.065, 0.057, 0.049],
    graphite: [0.31, 0.285, 0.255],
    paper: [0.78, 0.75, 0.69],
  },
  lighting: {
    keyColor: [0.73, 0.69, 0.62],
    keyEnergy: 110,
    keySize: 3.4,
    keyPosition: [-2.0, -3.5, 2.4],
    ambientFill: 0.34,
  },
  grainScale: 42,
  grainStrength: 0.09,
  vignetteStrength: 0.2,
  hazeStrength: 0.025,
  paperFiberScale: 240,
  paperOpacity: 0.045,
  lineBoilStrength: 0.12,
} as const;

export const CHARCOAL_HORROR_STYLE_2_0 = {
  ...CHARCOAL_HORROR_STYLE,
  version: '2.0.0',
  edgeBreakup: 0.24,
  edgeSoftness: 0.015,
  shadowSmudge: 0.18,
  graphiteSheen: 0.16,
  contrastCurve: [0.12, 0.88] as const,
  paperWhitePoint: 0.78,
  hazeDrift: 0.12,
  dustDensity: 0,
  shadows: 'soft-cast' as const,
} as const;

export const STYLE_DEFINITIONS = {
  'charcoal_horror@1.2.0': CHARCOAL_HORROR_STYLE,
  'charcoal_horror@2.0.0': CHARCOAL_HORROR_STYLE_2_0,
} as const;

export function resolveCharcoalHorrorStyle(
  overrides: CharcoalStyleOverrides = {},
) {
  return {
    id: CHARCOAL_HORROR_STYLE.id,
    version: CHARCOAL_HORROR_STYLE.version,
    palette: {
      shadow: overrides.palette?.shadow ?? CHARCOAL_HORROR_STYLE.palette.shadow,
      graphite:
        overrides.palette?.graphite ?? CHARCOAL_HORROR_STYLE.palette.graphite,
      paper: overrides.palette?.paper ?? CHARCOAL_HORROR_STYLE.palette.paper,
    },
    lighting: {
      keyColor:
        overrides.lighting?.keyColor ?? CHARCOAL_HORROR_STYLE.lighting.keyColor,
      keyEnergy:
        overrides.lighting?.keyEnergy ??
        CHARCOAL_HORROR_STYLE.lighting.keyEnergy,
      keySize:
        overrides.lighting?.keySize ?? CHARCOAL_HORROR_STYLE.lighting.keySize,
      keyPosition:
        overrides.lighting?.keyPosition ??
        CHARCOAL_HORROR_STYLE.lighting.keyPosition,
      ambientFill:
        overrides.lighting?.ambientFill ??
        CHARCOAL_HORROR_STYLE.lighting.ambientFill,
    },
    grainScale: overrides.grainScale ?? CHARCOAL_HORROR_STYLE.grainScale,
    grainStrength:
      overrides.grainStrength ?? CHARCOAL_HORROR_STYLE.grainStrength,
    vignetteStrength:
      overrides.vignetteStrength ?? CHARCOAL_HORROR_STYLE.vignetteStrength,
    hazeStrength: overrides.hazeStrength ?? CHARCOAL_HORROR_STYLE.hazeStrength,
    paperFiberScale:
      overrides.paperFiberScale ?? CHARCOAL_HORROR_STYLE.paperFiberScale,
    paperOpacity: overrides.paperOpacity ?? CHARCOAL_HORROR_STYLE.paperOpacity,
    lineBoilStrength:
      overrides.lineBoilStrength ?? CHARCOAL_HORROR_STYLE.lineBoilStrength,
  };
}

function resolveCharcoalStyle(
  preset: string,
  version: string,
  overrides: CharcoalStyleOverrides = {},
) {
  const normalizedVersion = version === '1.1.0' ? '1.2.0' : version;
  const registryKey =
    `${preset}@${normalizedVersion}` as keyof typeof STYLE_DEFINITIONS;
  const definition = STYLE_DEFINITIONS[registryKey] as
    typeof CHARCOAL_HORROR_STYLE_2_0 | undefined;
  const registered = STYLE_DEFINITION_REGISTRY.some(
    (item) => item.id === preset && item.version === normalizedVersion,
  );
  if (!definition || !registered)
    throw new TypeError(
      `Unknown style "${preset}@${version}". Registered styles: ${Object.keys(STYLE_DEFINITIONS).join(', ')}`,
    );
  const base = resolveCharcoalHorrorStyle(overrides);
  if (version === '1.1.0' || version === '1.2.0') return base;
  return {
    ...base,
    id: definition.id,
    version: definition.version,
    edgeBreakup: overrides.edgeBreakup ?? definition.edgeBreakup,
    edgeSoftness: overrides.edgeSoftness ?? definition.edgeSoftness,
    shadowSmudge: overrides.shadowSmudge ?? definition.shadowSmudge,
    graphiteSheen: overrides.graphiteSheen ?? definition.graphiteSheen,
    contrastCurve: overrides.contrastCurve ?? definition.contrastCurve,
    paperWhitePoint: overrides.paperWhitePoint ?? definition.paperWhitePoint,
    hazeDrift: overrides.hazeDrift ?? definition.hazeDrift,
    dustDensity: overrides.dustDensity ?? definition.dustDensity,
    shadows: overrides.shadows ?? definition.shadows,
    glow: overrides.glow ?? true,
    finalGrade: overrides.finalGrade ?? true,
  };
}

export function compileStyle(scene: ShotScene) {
  const profile = STYLE_DEFINITION_REGISTRY.find(
    ({ id, version }) =>
      id === scene.stylePreset && version === scene.styleVersion,
  );
  if (!profile)
    throw new TypeError(
      `Unknown visual profile ${scene.stylePreset}@${scene.styleVersion}`,
    );
  if (profile.shading !== 'charcoal') return profile;
  return {
    ...profile,
    parameters: {
      ...resolveCharcoalStyle(
        scene.stylePreset,
        scene.styleVersion,
        scene.styleOverrides,
      ),
      ...(scene.styleOverrides?.boilFps
        ? { boilFps: scene.styleOverrides.boilFps }
        : {}),
    },
  };
}
