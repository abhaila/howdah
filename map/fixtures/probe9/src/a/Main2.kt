package a

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer
import lib.svc
import b.svc as svc2
import c.other as svc

fun main2() {
    svc().asServer(SunHttp(2)).start()
}
