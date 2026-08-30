// packages/research-workbench/esbuild.worker.config.mjs
//
// [목적] 워커 번들 안정화 — SDK 공식 프리셋(createPluginBundlerPresets)으로 worker를
//   완전 번들한다(bundle:true, external은 react 계열뿐). 그 결과 dist/worker.js는
//   런타임 node_modules 해석에 의존하지 않는 단일 파일이 되어, 배포 시 pnpm 스토어
//   정리로 SDK 심볼릭 링크가 죽어도(2026-08-30 A1 사고) 플러그인이 살아남는다.
// [계약] tsc 빌드는 유지한다 — 테스트(dist/adapters/* 등 산출물)와 타입이 이걸 쓴다.
//   이 스크립트는 tsc 직후 실행되어 dist/worker.js만 번들본으로 덮어쓴다.
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ sourcemap: false });
await esbuild.build(presets.esbuild.worker);
console.log("bundled dist/worker.js (self-contained)");
