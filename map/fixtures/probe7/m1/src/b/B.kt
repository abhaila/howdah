package b

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

fun svc() = routes("/decoyB" bind GET to ::hb)
fun hb(r: Request): Response = TODO()
