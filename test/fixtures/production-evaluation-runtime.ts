import { readFile } from 'node:fs/promises'
import {
  createProductionEvaluationRuntime,
  type ProductionEvaluationRuntimeOptions,
} from '../../apps/runtime/src/evaluation/productionRuntime.js'

const configPath = process.argv[2]
if (!configPath) throw new Error('Production evaluation Runtime requires a config path.')
const options = JSON.parse(await readFile(configPath, 'utf8')) as ProductionEvaluationRuntimeOptions
createProductionEvaluationRuntime(options).start()
