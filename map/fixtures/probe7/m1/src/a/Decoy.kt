package a

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

fun app() = routes("/decoyA" bind GET to ::h)
fun h(r: Request): Response = TODO()
