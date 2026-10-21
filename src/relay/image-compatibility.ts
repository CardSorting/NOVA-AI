/** Explicit opt-in compatibility contract: this is a tool route, not an exact GPT Image model guarantee. */
export const CODEX_IMAGE_ALIAS = Object.freeze({
  requestedModel: 'gpt-image-2', executionModel: 'gpt-image-2',
  routingMode: 'codex_image_tool_alias', tool: 'image_gen.imagegen',
  imageModelSelection: 'provider_managed',
});
export const IMAGE_TOOL_EVIDENCE_TTL_MS = 3600000;
export function imageExecution(requestedModel: string, apiKey: boolean, enabled: boolean) {
  return !apiKey && enabled && requestedModel === CODEX_IMAGE_ALIAS.requestedModel
    ? CODEX_IMAGE_ALIAS : { requestedModel, executionModel: requestedModel, routingMode: 'exact', tool: undefined, imageModelSelection: 'exact' };
}
