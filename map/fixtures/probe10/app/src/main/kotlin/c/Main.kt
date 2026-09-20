package c

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

fun api() = routes("/decoyApp" bind GET to ::ha)
fun ha(r: Request): Response = TODO()

fun main() {
    api(Cfg()).asServer(SunHttp(1)).start()
}
