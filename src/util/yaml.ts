import YAML, { Options } from 'yaml'

export function yamlStringifyNoFold(value: unknown, options?: Options) {
  let orig = YAML.scalarOptions.str.fold.lineWidth
  YAML.scalarOptions.str.fold.lineWidth = 0
  try {
    return YAML.stringify(value, options)
  } finally {
    YAML.scalarOptions.str.fold.lineWidth = orig
  }
}
