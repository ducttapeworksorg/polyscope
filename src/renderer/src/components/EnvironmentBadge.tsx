import type { Environment } from '@shared/core-api'
import { environmentStyle } from '../environments'

/** A pill in the Environment's colour, carrying its name. */
export function EnvironmentBadge({ environment, id }: { environment: Environment; id?: string }) {
  return (
    <span id={id} className="env-badge" style={environmentStyle(environment)}>
      {environment.name}
    </span>
  )
}
