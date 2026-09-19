package c

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

internal fun api() = routes("/decoyC" bind GET to ::hc)
fun hc(r: Request): Response = TODO()
