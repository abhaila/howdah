package d

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

fun api2() = routes("/commentedDep" bind GET to ::hl)
fun hl(r: Request): Response = TODO()
