const path = require( 'path' )
const webpack = require( 'webpack' )
const { webpackHelper } = require( '@venkatperi/webpack-helper' )
const pkg = require( './package.json' )

const cwd = __dirname
let buildDir = 'dist'

const modules = {
  mode: true,
  vue: true,
  ts: true,
  miniExtractCss: true,
  optimizeCss: true,
  style: true,
  img: true,
  ext: true,
  devServer: true,
  misc: true,
  dev: true,
  prod: true,
}

const variants = [
  'cjs',
  'umd',
]

module.exports = webpackHelper( variants, modules, cwd, buildDir, webpack, ( config ) => {
  config
    .entry( 'xterm-local-echo' )
    .add( './src/index.ts' )

  config.output
    .path( path.resolve( __dirname, './dist' ) );
} )

