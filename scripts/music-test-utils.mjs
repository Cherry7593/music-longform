import { build } from 'esbuild'
import path from 'node:path'
import { createRequire } from 'node:module'

/** Bundle the same production adapters/state engine; test fixtures are explicitly opt-in. */
export async function loadMusicEngine(directory, fixtures = false) {
  const output = path.join(directory, 'music-api-engine.cjs')
  const sharpEntry = createRequire(import.meta.url).resolve('sharp')
  await build({ stdin: { contents: `
    export * from './src/main/video/ffmpeg';
    export {MusicRegistry} from './src/main/providers/music-registry';
    export {saveGeneratedAudio} from './src/main/generated-audio';
    export {JobManager} from './tests/fixtures/v31/main/jobs';
    export {SettingsStore} from './tests/fixtures/v31/main/storage/settings';
    export {ProjectStore} from './tests/fixtures/v31/main/storage/projects';
    export {LibraryStore} from './tests/fixtures/v31/main/storage/library';
    export {defaultMusicDraft} from './src/shared/music-capabilities';
    export {aceStepAddressSchema} from './src/shared/music-schemas';
    ${fixtures ? "export {startAceStepFixture} from './tests/fixtures/acestep-server';" : ''}
  `, resolveDir: path.resolve('.') }, outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    alias: { sharp: sharpEntry }, external: [sharpEntry], logLevel: 'silent' })
  return createRequire(import.meta.url)(output)
}
