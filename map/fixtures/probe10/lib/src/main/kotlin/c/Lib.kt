package c

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

fun api(cfg: Cfg) = routes("/realFromLib" bind GET to ::hl)
fun hl(r: Request): Response = TODO()
