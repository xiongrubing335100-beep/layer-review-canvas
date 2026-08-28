const featureEnvironmentKeys = {
  compact_plan_v1: 'IMVIA_COMPACT_PLAN_V1',
  route_aware_context_v1: 'IMVIA_ROUTE_AWARE_CONTEXT_V1',
  targeted_preflight_v1: 'IMVIA_TARGETED_PREFLIGHT_V1',
  targeted_finalizer_v1: 'IMVIA_TARGETED_FINALIZER_V1',
  poster_layering_mode: 'IMVIA_FEATURE_POSTER_LAYERING_MODE',
};

export function isExecutionFeatureEnabled(name, environment = globalThis.process?.env || {}) {
  const key = featureEnvironmentKeys[name];
  if (!key) throw new Error(`unknown execution feature: ${name}`);
  return environment[key] !== '0';
}

export function executionFeatureEnvironmentKey(name) {
  const key = featureEnvironmentKeys[name];
  if (!key) throw new Error(`unknown execution feature: ${name}`);
  return key;
}
