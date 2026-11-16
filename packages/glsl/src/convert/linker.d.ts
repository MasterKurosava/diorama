// three r187 ships the Linker without typings.
declare module 'three/addons/transpiler/Linker.js' {
  export default class Linker {
    process(ast: object): void
  }
}
