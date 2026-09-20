package a

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer
import lib.app

fun main() {
    app().asServer(SunHttp(1)).start()
}
