package s

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

fun h(r: Request): Response = TODO()

fun createApp(extra: RoutingHttpHandler) = routes("/internal" bind extra)

fun main() {
    routes("/a" bind GET to ::h).withBasePath("/v2").asServer(SunHttp(2)).start()
    createApp(routes("/debug" bind GET to ::h)).asServer(SunHttp(3)).start()
}
