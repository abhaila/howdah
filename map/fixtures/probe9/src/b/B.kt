package b

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

fun app() = routes("/twoImports" bind GET to ::hb)
fun svc() = routes("/aliasAndPlain" bind GET to ::hb)
fun hb(r: Request): Response = TODO()
