declare namespace WebAssembly {
  type ImportExportKind = "function" | "table" | "memory" | "global";
  type ExportValue = Function | Memory;
  type Exports = Record<string, ExportValue>;
  type Imports = Record<string, Record<string, Function>>;
  type ModuleImportDescriptor = {
    module: string;
    name: string;
    kind: ImportExportKind;
  };

  class Memory {
    readonly buffer: ArrayBuffer;
  }

  class Module {
    static imports(module: Module): ModuleImportDescriptor[];
  }

  class Instance {
    readonly exports: Exports;
  }

  class RuntimeError extends Error {}

  function instantiate(
    bytes: ArrayBufferLike | ArrayBufferView,
    importObject?: Imports,
  ): Promise<{ module: Module; instance: Instance }>;

  function compile(bytes: ArrayBufferLike | ArrayBufferView): Promise<Module>;
}

declare function fetch(input: URL | string): Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
