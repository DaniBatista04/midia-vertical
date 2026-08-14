import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * O ffmpeg-static descobre o binário a partir do __dirname do próprio
   * pacote. Se o bundler o empacotar, esse __dirname vira o diretório do
   * chunk e o caminho aponta para lugar nenhum — o spawn falha só em runtime.
   * Mantê-lo externo faz o require acontecer de verdade, em node_modules.
   */
  serverExternalPackages: ["ffmpeg-static"],

  /*
   * E o tracing não enxerga um binário resolvido em runtime, então ele
   * precisa ser incluído à mão ou não sobe junto para a Vercel.
   */
  outputFileTracingIncludes: {
    "/api/transcode": ["./node_modules/ffmpeg-static/ffmpeg"],
  },
};

export default nextConfig;
