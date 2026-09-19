package c

import org.http4k.core.Method.GET
import org.http4k.routing.bind
import org.http4k.routing.routes
import org.http4k.server.asServer

fun other() = routes("/aliasTarget" bind GET to ::hc)
fun hc(r: Request): Response = TODO()

class Holder {
    companion object {
        fun api() = routes("/topHolder" bind GET to ::hc)
    }
}

class X {
    class Holder {
        companion object {
            fun api() = routes("/nestedHolder" bind GET to ::hc)
        }
    }
    fun start() {
        Holder.api().asServer(SunHttp(3)).start()
    }
}
