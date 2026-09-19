package a

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer
import b.svc as other
import lib2.*

fun main2() {
    svc().asServer(SunHttp(2)).start()
}
