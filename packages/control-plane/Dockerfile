FROM maven:3.9-eclipse-temurin-25 AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -q
COPY src ./src
RUN mvn package -DskipTests -q -Pnative || mvn package -DskipTests -q

FROM eclipse-temurin:25-jre
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/*.jar app.jar
ENV JAVA_TOOL_OPTIONS="-Xmx384m -Xss512k -XX:MaxMetaspaceSize=128m -XX:+UseSerialGC"
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
