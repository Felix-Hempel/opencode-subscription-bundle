// OmO 5.1.7 erkennt status.retry über Textmuster, nicht über dessen HTTP-Code.
// Bekannte Subscription-/Regionsfehler früh klassifizieren, damit native Retry-Loops nicht erst auslaufen müssen.
export default async function ProviderErrorNormalizer() {
  return {
    async event({ event }) {
      const status = event.properties?.status;
      if (event.type !== "session.status" || status?.type !== "retry" || typeof status.message !== "string") return;
      if (/requires global regions|select global.{0,50}privacy|region.{0,30}not supported/i.test(status.message)) {
        status.message = `Model not supported for current workspace region: ${status.message}`;
      } else if (/weekly.*limit|usage[_ -]limit|subscription.*limit|out of extra usage/i.test(status.message) && !/quota.?exceeded/i.test(status.message)) {
        status.message = `Quota exceeded: ${status.message}`;
      } else if (/failed to authenticate|oauth.{0,40}(expired|invalid)|token refresh failed/i.test(status.message) && !/service.?unavailable/i.test(status.message)) {
        status.message = `Service unavailable due to authentication: ${status.message}`;
      }
    },
  };
}
