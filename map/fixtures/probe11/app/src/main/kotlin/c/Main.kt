package c

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

fun main() {
    api().asServer(SunHttp(1)).start()
}
