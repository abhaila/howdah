package com.example.api

interface Logger {
    fun info(message: String)
}

context(logger: Logger)
fun audit(event: String) {
    logger.info(event)
}

fun afterAudit(value: Int): Int = value + 1
