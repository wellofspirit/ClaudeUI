import type { SharedProviderRouteDiagnosis } from '../../../../shared/shared-provider'

/**
 * Why an enabled, credentialed route still surfaces nothing — appended to the
 * list row's own line, and shown in place of a pi curation list whose catalog
 * is empty (ADR-074 §5). The wording is `SharedProviders`': each string names
 * the CAUSE first, so it stays legible truncated, and says where the fix is. A
 * bare "0 models" is what made this class of failure opaque.
 *
 * Its own module because both the list and the sheet's curation block render
 * it, and the list imports the sheet (never the other way round).
 */
export function diagnosisText(diagnosis: SharedProviderRouteDiagnosis): string {
  switch (diagnosis) {
    case 'provider-disabled':
      return 'Disabled in the engine — turn it back on below.'
    case 'models-restricted':
      return 'Every model is filtered out — adjust the model list below.'
    case 'no-credential':
      return 'pi reports no models for this provider — check its key, or its entry in ~/.pi/agent/models.json.'
    case 'no-models-discovered':
      return 'The engine reported no models — check it is installed and reachable.'
  }
}
