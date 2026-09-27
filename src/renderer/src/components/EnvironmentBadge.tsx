import type { Environment } from '@shared/core-api'
import { environmentStyle } from '../environments'

/** A pill in the Environment's colour, carrying its name. */
export function EnvironmentBadge({ environment }: { environment: Environment }) {
  return (
    <span className="env-badge" style={environmentStyle(environment)}>
      {environment.name}
    </span>
  )
}
