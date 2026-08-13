import { build } from 'esbuild';

/**
 * Bundle the widget into one file a host page can serve.
 *
 * `iife`, not `esm`: the bundle has to work from a plain `<script>` tag on any page, including
 * ones that cannot use modules, and `document.currentScript` — which the auto-mount reads — is
 * null inside a module script.
 *
 * `es2022` because a custom element with private fields already requires a modern browser; there
 * is no version of this widget that runs where `customElements` does not.
 *
 * No `--minify` on the default target: the file is small enough that readability during
 * integration is worth more than the bytes, and a host that cares runs the minified target.
 */
const shared = {
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  legalComments: 'none',
  // Nothing is external. A widget that needs the host to provide a dependency is a widget with
  // an installation guide.
  external: [],
};

const outputs = [
  { ...shared, outfile: 'dist/shopsage.js', minify: false },
  { ...shared, outfile: 'dist/shopsage.min.js', minify: true },
];

for (const options of outputs) {
  // Cast because the shared literal widens `format` and `target` to `string`, and esbuild's
  // options are unions of specific strings. The values are checked by esbuild itself at run
  // time, so restating them as literal types here would be ceremony.
  const result = await build({ .../** @type {any} */ (options), metafile: true });
  const [output] = Object.entries(result.metafile?.outputs ?? {});

  process.stdout.write(`${output[0]}  ${(output[1].bytes / 1024).toFixed(1)} kB\n`);
}
