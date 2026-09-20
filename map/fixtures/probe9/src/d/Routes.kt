package d

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

val apiRoutes = routes("/x" bind GET to ::hd)
typealias Factory = () -> RoutingHttpHandler
val makeApp: Factory = { routes("/fromFactory" bind GET to ::hd) }
fun hd(r: Request): Response = TODO()
