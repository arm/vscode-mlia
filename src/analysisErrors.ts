export const eulaAcceptanceRequiredMessage =
  "EULA acceptance is required. Run the analysis again and accept the EULA to continue.";

/** Translate CLI-oriented errors into actions available in the extension. */
export function analysisErrorMessage(message: string): string {
  if (/^EULA acceptance required\b/.test(message.trim())) {
    return eulaAcceptanceRequiredMessage;
  }
  return message;
}
